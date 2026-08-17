import { app, BrowserWindow, Notification, shell } from "electron";
import log from "electron-log/main";
import delay from "delay";
import moment from "moment";
import {
    SSOOIDCClient,
    RegisterClientCommand,
    StartDeviceAuthorizationCommand,
    CreateTokenCommand,
    AuthorizationPendingException,
    type CreateTokenCommandOutput,
} from "@aws-sdk/client-sso-oidc";
import { v4 as uuidv4 } from "uuid";
import {
    config,
    UserConfig,
    BehaviorConfig,
    DEFAULT_BEHAVIOR,
} from "./config.js";
import { refreshProfiles } from "./profiles.js";
import { writeSsoConfig } from "./aws-config.js";
import { updateTrayIcon } from "./tray.js";
import { updateKubeConfig } from "./aws-eks.js";
import { attachLoginIndicator } from "./login-indicator.js";
import {
    startRun,
    completeRun,
    startTokenStep,
    completeTokenStep,
} from "./run-log.js";

let timeoutId: NodeJS.Timeout | undefined;
let pendingAuthResolve: (() => void) | null = null;

export function hasPendingAuth(): boolean {
    return pendingAuthResolve !== null;
}

export function triggerPendingAuth() {
    if (pendingAuthResolve) {
        pendingAuthResolve();
        pendingAuthResolve = null;
    }
}

function waitForUserTrigger(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const tid = setTimeout(() => {
            pendingAuthResolve = null;
            reject(new Error("Timed out waiting for user to trigger auth"));
        }, timeoutMs);
        pendingAuthResolve = () => {
            clearTimeout(tid);
            resolve();
        };
    });
}

export function setNextTokenRefresh() {
    log.info("[setNextTokenRefresh] Setting new timeout");

    if (timeoutId) {
        log.info("[setNextTokenRefresh] Clearing existing timeout");
        clearTimeout(timeoutId);
    }

    const now = moment();
    const expiresAtConfig = config.get("expiresAt") as string | undefined;
    log.debug("[setNextTokenRefresh] Config expiresAt=%s", expiresAtConfig);
    const expiresAt = expiresAtConfig
        ? moment(expiresAtConfig, moment.ISO_8601)
        : now;
    const timeoutMs = Math.max(expiresAt.diff(now), 500);

    timeoutId = setTimeout(refresh, timeoutMs);
    log.info("[setNextTokenRefresh] New timeout set to %sms", timeoutMs);
}

export async function refresh() {
    log.info("[refresh] Refreshing credentials");

    const userConfig = config.get("userConfig") as UserConfig;
    log.debug("[refresh] userConfig=%s", userConfig);

    if (!userConfig) {
        log.warn("[refresh] Missing user config, cannot refresh credentials");
        return;
    }

    // A second refresh would overwrite the single current-run slot in run-log,
    // stranding the first run as "in-progress" forever and writing its
    // remaining steps onto the wrong run.
    if (config.get("isWorking")) {
        log.warn("[refresh] A refresh is already in progress, skipping");
        return;
    }

    startRun();

    try {
        config.set("isWorking", true);
        updateTrayIcon();

        startTokenStep();
        let newToken: CreateTokenCommandOutput;
        try {
            newToken = await getNewToken(userConfig);
            log.info("[refresh] Successfully got new token");
            completeTokenStep("success");
        } catch (tokenErr) {
            completeTokenStep("error", `${tokenErr}`);
            throw tokenErr;
        }

        await saveToken(userConfig, newToken);
        setNextTokenRefresh();

        const profiles = await refreshProfiles();
        await updateKubeConfig(profiles);

        completeRun("success");
    } catch (err) {
        log.error("[refresh] Error: %s", err);
        if (err instanceof Error && err.name == "InvalidClientException") {
            config.delete("ssoClient");
            log.error(
                "[refresh] Got InvalidClientException error, deleted ssoClient from config"
            );
        }
        config.set("lastError", `${err}`);
        completeRun("error", `${err}`);
        setNextTokenRefresh();
    } finally {
        config.set("isWorking", false);
        updateTrayIcon();
    }
}

async function getNewToken(
    userConfig: UserConfig
): Promise<CreateTokenCommandOutput> {
    config.set("lastError", null);
    const client = await getSsoClient(userConfig);
    const ssooidc = new SSOOIDCClient({ region: userConfig.region });

    const startAuth = await ssooidc.send(
        new StartDeviceAuthorizationCommand({
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            startUrl: userConfig.startUrl,
        })
    );

    log.debug("[getNewToken] startDeviceAuthorization: %s", startAuth);
    const tokenExpires = moment().add(startAuth.expiresIn, "seconds");

    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;

    if (behavior.refreshMode === "notify") {
        const displayKey = behavior.refreshHotkey
            .replace("CmdOrCtrl", "⌘/Ctrl")
            .replace("Shift", "⇧")
            .replace("Alt", "⌥");
        log.info("[getNewToken] Notify mode: showing notification");
        const note = new Notification({
            title: "Frost — AWS Credentials Renewal",
            body: `Press ${displayKey} to open the AWS login browser.`,
        });
        note.on("click", () => triggerPendingAuth());
        note.show();
        await waitForUserTrigger(startAuth.expiresIn! * 1000);
    }

    // In default-browser mode there is no window to watch, so windowOpen stays
    // true and the poll loop runs until the device code expires.
    let windowOpen = true;
    let window: BrowserWindow | undefined;

    if (behavior.loginMethod === "default_browser") {
        log.debug("[getNewToken] Opening login in default browser");
        await shell.openExternal(startAuth.verificationUriComplete!);
    } else {
        log.debug("[getNewToken] Opening login window");
        if (app.dock) await app.dock.show();

        window = new BrowserWindow({
            width: 550,
            height: 700,
            center: true,
            webPreferences: {
                nodeIntegration: false,
            },
        });

        // Before loadURL, so the very first document gets the overlay that
        // shows when the page is waiting for a security key or passkey. The
        // default-browser path needs nothing: the browser has its own UI.
        attachLoginIndicator(window);

        window.on("close", () => {
            log.warn("[getNewToken] Login window closed");
            windowOpen = false;
        });

        window.loadURL(startAuth.verificationUriComplete!);
    }

    try {
        while (moment().isBefore(tokenExpires)) {
            log.debug("[getNewToken] Sleeping for %ss", startAuth.interval!);
            await delay(startAuth.interval! * 1000);

            // Closing the window means "I'm not logging in now". Give up here
            // rather than waiting for a non-pending token error, which may
            // never come — the run would then hold `isWorking` (and block every
            // new refresh) until the device code expires.
            if (!windowOpen) {
                log.warn("[getNewToken] User closed login window, aborting");
                throw new Error("Login window closed");
            }

            try {
                log.debug("[getNewToken] Trying to get token");
                return await ssooidc.send(
                    new CreateTokenCommand({
                        clientId: client.clientId,
                        clientSecret: client.clientSecret,
                        deviceCode: startAuth.deviceCode!,
                        grantType:
                            "urn:ietf:params:oauth:grant-type:device_code",
                    })
                );
            } catch (err) {
                if (isAuthorizationPendingException(err)) {
                    log.debug("[getNewToken] Authorization pending...");
                } else {
                    log.warn("[getNewToken] Failed getting token: %s", err);
                }
            }
        }
        throw new Error("Login timed out");
    } finally {
        if (window && !window.isDestroyed()) {
            window.close();
        }
    }
}

function isAuthorizationPendingException(err: unknown): boolean {
    return err instanceof AuthorizationPendingException;
}

async function saveToken(
    userConfig: UserConfig,
    newToken: CreateTokenCommandOutput
) {
    const expiresAt = moment().add(newToken.expiresIn!, "seconds");
    config.set("accessToken", newToken.accessToken!);
    config.set("expiresAt", expiresAt.toISOString());
    await writeSsoConfig(
        userConfig,
        newToken.accessToken!,
        expiresAt.toISOString()
    );
}

export interface RegisteredClient {
    clientName: string;
    clientId: string;
    clientSecret: string;
    issuedAt: number;
    expiresAt: number;
}

async function getSsoClient(userConfig: UserConfig): Promise<RegisteredClient> {
    let registeredClient = config.get("ssoClient") as RegisteredClient;

    if (!registeredClient) {
        log.info(`[getSsoClient] Registering new client`);
        const clientName = `Frost-${uuidv4()}`;
        registeredClient = await registerSsoClient(userConfig, clientName);
    } else if (moment.unix(registeredClient.expiresAt).isBefore(moment())) {
        log.info(`[getSsoClient] Re-registering expired client`);
        registeredClient = await registerSsoClient(
            userConfig,
            registeredClient.clientName
        );
    }

    log.debug(
        "[getSsoClient] Returning clientId=%s issuedAt=%s expiresAt=%s",
        registeredClient.clientId,
        registeredClient.issuedAt,
        registeredClient.expiresAt
    );
    return registeredClient;
}

async function registerSsoClient(
    userConfig: UserConfig,
    clientName: string
): Promise<RegisteredClient> {
    log.debug("[registerSsoClient] Registering client %s", clientName);
    const ssooidc = new SSOOIDCClient({ region: userConfig.region });

    const res = await ssooidc.send(
        new RegisterClientCommand({
            clientName,
            clientType: "public",
        })
    );

    const registeredClient = {
        clientName,
        clientId: res.clientId!,
        clientSecret: res.clientSecret!,
        issuedAt: res.clientIdIssuedAt!,
        expiresAt: res.clientSecretExpiresAt!,
    };

    config.set("ssoClient", registeredClient);
    return registeredClient;
}
