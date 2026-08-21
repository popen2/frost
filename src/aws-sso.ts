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
    ExpiredTokenException,
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
import { formatHotkey } from "./hotkey.js";
import {
    startRun,
    completeRun,
    startTokenStep,
    completeTokenStep,
} from "./run-log.js";
import { describeError } from "./logging.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import {
    LoginAbortedError,
    nextRefreshDelayMs,
    retryDelayMsAfterError,
} from "./schedule.js";

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
            reject(
                new LoginAbortedError(
                    "Timed out waiting for user to trigger auth"
                )
            );
        }, timeoutMs);
        pendingAuthResolve = () => {
            clearTimeout(tid);
            resolve();
        };
    });
}

export function setNextTokenRefresh(delayMs?: number) {
    log.info("[setNextTokenRefresh] Setting new timeout");

    if (timeoutId) {
        log.info("[setNextTokenRefresh] Clearing existing timeout");
        clearTimeout(timeoutId);
    }

    const expiresAtConfig = config.get("expiresAt") as string | undefined;
    log.debug("[setNextTokenRefresh] Config expiresAt=%s", expiresAtConfig);
    const timeoutMs =
        delayMs ?? nextRefreshDelayMs(expiresAtConfig, Date.now());

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

    // The run id is what ties these lines to the entry the user is looking at
    // in the Activity panel when they send a log in.
    const { runId } = startRun();
    log.info("[refresh] Run %s started", runId);

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
            completeTokenStep("error", describeError(tokenErr));
            throw tokenErr;
        }

        await saveToken(userConfig, newToken);
        setNextTokenRefresh();

        const profiles = await refreshProfiles();
        await updateKubeConfig(profiles);

        completeRun("success");
        log.info("[refresh] Run %s completed", runId);
    } catch (err) {
        const described = describeError(err);
        log.error("[refresh] Run %s failed: %s", runId, described);
        if (err instanceof Error && err.name == "InvalidClientException") {
            config.delete("ssoClient");
            log.error(
                "[refresh] Got InvalidClientException error, deleted ssoClient from config"
            );
        }
        config.set("lastError", described);
        completeRun("error", described);

        // A failed run leaves `expiresAt` in the past, so scheduling off it would
        // retry in MIN_REFRESH_DELAY_MS and start a whole new login every half
        // second. Retry on a fixed delay, and not at all when the reason we failed
        // is that nobody completed the login.
        const retryDelayMs = retryDelayMsAfterError(err);
        if (retryDelayMs === undefined) {
            log.warn(
                "[refresh] Login was not completed, waiting for a manual refresh"
            );
        } else {
            setNextTokenRefresh(retryDelayMs);
        }
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

    // Never log the response itself: it carries `deviceCode`, `userCode` and
    // `verificationUriComplete`, and anything holding those plus the client
    // credentials can redeem a token of its own for as long as the code lives.
    log.debug(
        "[getNewToken] startDeviceAuthorization: expiresIn=%ss interval=%ss",
        startAuth.expiresIn,
        startAuth.interval
    );
    const tokenExpires = moment().add(startAuth.expiresIn, "seconds");

    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;

    if (behavior.refreshMode === "notify") {
        log.info("[getNewToken] Notify mode: showing notification");
        const note = new Notification({
            title: "Frost — AWS Credentials Renewal",
            body: `Press ${formatHotkey(
                behavior.refreshHotkey
            )} to open the AWS login browser.`,
        });
        note.on("click", () => triggerPendingAuth());
        note.show();
        await waitForUserTrigger(startAuth.expiresIn! * 1000);
    }

    // In default-browser mode there is no window to watch, so windowOpen stays
    // true and the poll loop runs until the device code expires.
    let windowOpen = true;
    let window: BrowserWindow | undefined;

    const verificationUrl = startAuth.verificationUriComplete;
    if (!verificationUrl) {
        throw new Error("Missing verification URL from device authorization");
    }

    if (behavior.loginMethod === "default_browser") {
        log.debug("[getNewToken] Opening login in default browser");
        try {
            await shell.openExternal(verificationUrl);
        } catch (err) {
            throw new Error(
                `Failed opening login page in browser: ${err}`,
                { cause: err }
            );
        }
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

        window.loadURL(verificationUrl);
    }

    try {
        while (moment().isBefore(tokenExpires)) {
            log.debug("[getNewToken] Sleeping for %ss", startAuth.interval!);
            await delay(startAuth.interval! * 1000);

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
                } else if (err instanceof ExpiredTokenException) {
                    // The device code is dead, so there is nothing left to poll for.
                    throw new LoginAbortedError(
                        "Login page expired before it was approved"
                    );
                } else {
                    log.warn(
                        "[getNewToken] Failed getting token: %s",
                        describeError(err)
                    );
                }
            }

            // Closing the window means "I'm not logging in now". Give up here
            // rather than waiting for a non-pending token error, which may
            // never come — the run would then hold `isWorking` (and block every
            // new refresh) until the device code expires.
            //
            // This has to come *after* the poll above, not before it. AWS tells
            // the user to close the window as soon as they approve, so between
            // the approval and the next poll the window is usually already
            // gone — and checking first threw away a token that was waiting to
            // be collected.
            if (!windowOpen) {
                log.warn("[getNewToken] User closed login window, aborting");
                throw new LoginAbortedError("Login window closed");
            }
        }
        throw new LoginAbortedError("Login timed out");
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
    config.set("accessToken", encryptSecret(newToken.accessToken!));
    config.set("expiresAt", expiresAt.toISOString());
    // Plaintext here, deliberately: this is the AWS CLI's own cache format and
    // the CLI has to be able to read it. See the note in secrets.ts.
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

/**
 * The stored client with its secret decrypted, or null if there isn't one - or
 * if the secret was encrypted with a key this machine no longer has (a copied
 * profile directory, a reset keychain). Re-registering is cheap and is the only
 * way forward, so both cases look the same to the caller.
 */
function storedSsoClient(): RegisteredClient | null {
    const stored = config.get("ssoClient") as RegisteredClient | undefined;
    if (!stored) {
        return null;
    }

    const clientSecret = decryptSecret(stored.clientSecret);
    if (!clientSecret) {
        log.warn("[getSsoClient] Stored client secret unreadable");
        return null;
    }
    return { ...stored, clientSecret };
}

async function getSsoClient(userConfig: UserConfig): Promise<RegisteredClient> {
    let registeredClient = storedSsoClient();

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

    // Encrypted on the way to disk; the caller gets the usable secret back.
    config.set("ssoClient", {
        ...registeredClient,
        clientSecret: encryptSecret(registeredClient.clientSecret),
    });
    return registeredClient;
}
