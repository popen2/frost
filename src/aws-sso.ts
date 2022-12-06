import { BrowserWindow } from "electron";
import log from "electron-log";
import delay from "delay";
import moment from "moment";
import { SSOOIDC } from "aws-sdk";
import {
    AuthorizationPendingException,
    CreateTokenResponse,
} from "@aws-sdk/client-sso-oidc";
import { v4 as uuidv4 } from "uuid";
import { config, UserConfig } from "./config";
import { refreshProfiles } from "./profiles";
import { writeSsoConfig } from "./aws-config";
import { updateTrayIcon } from "./tray";
import { updateKubeConfig } from "./aws-eks";

let timeoutId: NodeJS.Timeout | undefined;

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
    const timeoutMs = Math.max(
        expiresAt.diff(now),
        500
    );

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

    try {
        config.set("isWorking", true);
        updateTrayIcon();

        const newToken = await getNewToken(userConfig);
        log.info("[refresh] Successfully got new token");
        await saveToken(userConfig, newToken);
        setNextTokenRefresh();

        const profiles = await refreshProfiles();
        await updateKubeConfig(profiles);
    } catch (err) {
        log.error("[refresh] Error: %s", err);
        if (err instanceof Error && err.name == "InvalidClientException") {
            config.delete("ssoClient");
            log.error(
                "[refresh] Got InvalidClientException error, deleted ssoClient from config"
            );
        }
        config.set("lastError", `${err}`);
        setNextTokenRefresh();
    } finally {
        config.set("isWorking", false);
        updateTrayIcon();
    }
}

async function getNewToken(
    userConfig: UserConfig
): Promise<CreateTokenResponse> {
    config.set("lastError", null);
    const client = await getSsoClient(userConfig);
    const ssooidc = new SSOOIDC({ region: userConfig.region });

    const startAuth = await ssooidc
        .startDeviceAuthorization({
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            startUrl: userConfig.startUrl,
        })
        .promise();

    log.debug("[getNewtoken] startDeviceAuthorization: %s", startAuth);
    const tokenExpires = moment().add(startAuth.expiresIn, "seconds");

    log.debug("[getNewToken] Opening login window");
    let windowOpen = true;
    const window = new BrowserWindow({
        width: 550,
        height: 700,
        center: true,
        alwaysOnTop: true,
        webPreferences: {
            nodeIntegration: false,
        },
    });

    try {
        window.on("close", () => {
            log.warn("[getNewToken] Login window closed");
            windowOpen = false;
        });

        window.loadURL(startAuth.verificationUriComplete!);

        while (moment().isBefore(tokenExpires)) {
            log.debug("[getNewToken] Sleeping for %ss", startAuth.interval!);
            await delay(startAuth.interval! * 1000);
            try {
                log.debug("[getNewToken] Trying to get token");
                return await ssooidc
                    .createToken({
                        clientId: client.clientId,
                        clientSecret: client.clientSecret,
                        deviceCode: startAuth.deviceCode!,
                        grantType:
                            "urn:ietf:params:oauth:grant-type:device_code",
                    })
                    .promise();
            } catch (err) {
                if (isAuthorizationPendingException(err)) {
                    log.debug("[getNewToken] Authorization pending...");
                } else {
                    log.warn("[getNewToken] Failed getting token: %s", err);
                    if (!windowOpen) {
                        log.warn("[getNewToken] User closed window");
                        throw err;
                    }
                }
            }
        }
        throw new Error("Login timed out");
    } finally {
        window.close();
    }
}

function isAuthorizationPendingException(
    err: any
): err is AuthorizationPendingException {
    return err?.name === "AuthorizationPendingException";
}

async function saveToken(
    userConfig: UserConfig,
    newToken: CreateTokenResponse
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
    const ssooidc = new SSOOIDC({ region: userConfig.region });

    const res = await ssooidc
        .registerClient({
            clientName,
            clientType: "public",
        })
        .promise();

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
