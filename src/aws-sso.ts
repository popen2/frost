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
    AccessDeniedException,
    ExpiredTokenException,
    SlowDownException,
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
import { attachAutoApprove } from "./auto-approve.js";
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
let nextRefreshAt: number | null = null;
let consecutiveFailures = 0;
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

    nextRefreshAt = Date.now() + timeoutMs;
    timeoutId = setTimeout(() => {
        timeoutId = undefined;
        nextRefreshAt = null;
        refresh();
    }, timeoutMs);
    log.info("[setNextTokenRefresh] New timeout set to %sms", timeoutMs);
}

/**
 * Stop refreshing until the user asks for one. The tray reads
 * getNextRefreshAt(), so "waiting for you" is visible rather than silent.
 */
export function cancelTokenRefresh() {
    if (timeoutId) {
        log.info("[cancelTokenRefresh] Clearing existing timeout");
        clearTimeout(timeoutId);
        timeoutId = undefined;
    }
    nextRefreshAt = null;
}

/** Epoch ms of the scheduled refresh, or null when none is pending. */
export function getNextRefreshAt(): number | null {
    return nextRefreshAt;
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

        consecutiveFailures = 0;
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
        scheduleAfterFailure(err);
    } finally {
        config.set("isWorking", false);
        updateTrayIcon();
    }
}

/** Whether the token Frost already holds is still good. */
function hasValidToken(): boolean {
    const expiresAt = config.get("expiresAt") as string | undefined;
    if (!expiresAt) {
        return false;
    }
    const parsed = moment(expiresAt, moment.ISO_8601);
    return parsed.isValid() && parsed.isAfter(moment());
}

/**
 * Decide when — or whether — to try again after a failed run.
 *
 * A failed run leaves `expiresAt` in the past, so scheduling off it would retry
 * in MIN_REFRESH_DELAY_MS and start a whole new login every half second. These
 * three outcomes want three different answers instead.
 */
function scheduleAfterFailure(err: unknown) {
    // The token step succeeded and something afterwards (profiles, EKS) did
    // not. The credentials are good, so stay on the ordinary expiry schedule:
    // an error retry here would re-run getNewToken() and put a login page on
    // screen every minute for a failure that has nothing to do with logging in.
    if (hasValidToken()) {
        consecutiveFailures = 0;
        setNextTokenRefresh();
        return;
    }

    const retryDelayMs = retryDelayMsAfterError(err, consecutiveFailures + 1);

    // Nobody completed the login. Another attempt would just open another
    // login page for nobody to complete.
    if (retryDelayMs === undefined) {
        consecutiveFailures = 0;
        cancelTokenRefresh();
        log.warn(
            "[refresh] Login was not completed, waiting for a manual refresh"
        );
        if (!(err instanceof LoginAbortedError) || !err.cancelledByUser) {
            notifyLoginNeeded();
        }
        return;
    }

    // Something failed before any login page opened — no network, an AWS error
    // registering the client. Nothing is on screen to pile up, and it may well
    // fix itself, so back off and retry.
    consecutiveFailures += 1;
    log.info(
        "[refresh] Failure %s in a row, retrying in %sms",
        consecutiveFailures,
        retryDelayMs
    );
    setNextTokenRefresh(retryDelayMs);
}

/**
 * Say once that Frost has stopped trying. Not retrying an abandoned login is
 * what keeps the browser clean; without this it would also be silent, and the
 * user would come back to credentials that expired hours ago with nothing
 * working on it.
 */
function notifyLoginNeeded() {
    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;
    const note = new Notification({
        title: "Frost — Sign-in Needed",
        body: `The AWS login was not completed. Press ${formatHotkey(
            behavior.refreshHotkey
        )} or use the tray to try again.`,
    });
    note.on("click", () => refresh());
    note.show();
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
    // Both fields are optional in the model. Without defaults an absent
    // `expiresIn` made `tokenExpires` equal to now (the poll loop never ran)
    // and an absent `interval` made the sleep NaN, which resolves at once and
    // turns the loop into a hot poll against AWS.
    const expiresInSec = startAuth.expiresIn ?? 600;
    const tokenExpires = moment().add(expiresInSec, "seconds");
    let pollIntervalMs = (startAuth.interval ?? 5) * 1000;

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
        await waitForUserTrigger(expiresInSec * 1000);
    }

    const verificationUrl = startAuth.verificationUriComplete;
    if (!verificationUrl) {
        throw new Error("Missing verification URL from device authorization");
    }

    const useBrowser = behavior.loginMethod === "default_browser";
    const silent = behavior.autoApprove !== false;

    // In default-browser mode there is no window to watch, so windowOpen stays
    // true and the poll loop runs until the device code expires.
    let windowOpen = true;
    let window: BrowserWindow | undefined;
    let closingForBrowser = false;
    let handedOver = false;

    const openInBrowser = async () => {
        log.debug("[getNewToken] Opening login in default browser");
        try {
            await shell.openExternal(verificationUrl);
        } catch (err) {
            throw new Error(
                `Failed opening login page in browser: ${describeError(err)}`,
                { cause: err }
            );
        }
    };

    /** Never throws: failing to show a window must not fail the run. */
    const showLoginWindow = (reason: string) => {
        try {
            if (!window || window.isDestroyed() || window.isVisible()) return;
            log.info("[getNewToken] Showing the login window: %s", reason);
            // Synchronously, before anything else: a WebAuthn account picker
            // arrives as a modal that blocks this process, so a show queued
            // behind it would come too late. The dock can catch up after.
            window.show();
            window.focus();
            if (app.dock) app.dock.show();
        } catch (err) {
            log.error(
                "[getNewToken] Could not show the login window: %s",
                describeError(err)
            );
        }
    };

    /**
     * The page needs the user. Give them whichever surface they asked for: the
     * window that has been driving itself so far, or — for someone who picked
     * the default browser, presumably because that is where their passkeys and
     * saved passwords live — that browser, with the silent attempt dropped.
     */
    const handOverToUser = (reason: string) => {
        if (!useBrowser) {
            showLoginWindow(reason);
            return;
        }

        // Once, however many things notice the page needs the user: every call
        // after the first would be another browser tab.
        if (handedOver) return;
        handedOver = true;
        log.info("[getNewToken] Handing the login to the browser: %s", reason);

        openInBrowser().then(
            () => {
                // Only now that the browser is up. Closing the probe first and
                // then failing to open anything would leave the run polling
                // with nothing on screen to sign in with.
                if (window && !window.isDestroyed()) {
                    closingForBrowser = true;
                    window.destroy();
                }
            },
            (err: unknown) => {
                log.error("[getNewToken] %s", describeError(err));
                showLoginWindow("the browser could not be opened");
            }
        );
    };

    // Opening the login page happens inside the try: each attempt starts its
    // own device authorization, so a window left behind by a throw would sit
    // there pointing at a code nothing polls any more.
    try {
        // Under automatic approval even the default-browser user gets a window
        // first: it stays off screen, and it is closed in favour of the browser
        // the moment the page turns out to need them.
        if (useBrowser && !silent) {
            await openInBrowser();
        } else {
            log.debug("[getNewToken] Opening login window (silent=%s)", silent);
            if (!silent && app.dock) await app.dock.show();

            window = new BrowserWindow({
                width: 550,
                height: 700,
                center: true,
                // Under automatic approval the window starts off screen and is
                // shown only if the page turns out to need the user — and in
                // default-browser mode it is never shown at all, it only probes
                // whether this refresh needs anyone. Background throttling
                // would slow the driver's scan loop to a crawl while hidden.
                show: !silent,
                webPreferences: {
                    nodeIntegration: false,
                    backgroundThrottling: false,
                },
            });

            // The page is remote, and Electron's default is to cancel a close
            // that a `beforeunload` handler objects to. That would strand this
            // window — and the user's own close with it. Unload regardless.
            window.webContents.on("will-prevent-unload", (event) =>
                event.preventDefault()
            );

            // Awaited, and before loadURL, so the very first document gets
            // the overlay that shows when the page is waiting for a security
            // key or passkey — a sign-in page that starts listening as it boots
            // asks for the key before any later hook could wrap the call. The
            // default-browser path needs nothing: the browser has its own UI.
            await attachLoginIndicator(window, handOverToUser);

            // Arming the overlay is asynchronous, and the user can close the
            // window while it happens. Nothing below survives a destroyed
            // window, and this is the same "I'm not logging in now" the close
            // handler reports.
            if (window.isDestroyed()) {
                throw new LoginAbortedError("Login window closed", {
                    cancelledByUser: true,
                });
            }

            // After the indicator, so the approval driver is not scanning a
            // window that turned out to be gone, and before loadURL, so it is
            // watching from the first document.
            if (silent) attachAutoApprove(window, handOverToUser);

            window.on("close", () => {
                // Frost closing the probe in favour of the browser is not the
                // user saying "not now".
                if (closingForBrowser) return;
                log.warn("[getNewToken] Login window closed");
                windowOpen = false;
            });

            window.loadURL(verificationUrl);
        }

            while (moment().isBefore(tokenExpires)) {
                log.debug("[getNewToken] Sleeping for %sms", pollIntervalMs);
                await delay(pollIntervalMs);

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
                    } else if (err instanceof SlowDownException) {
                        // RFC 8628 §3.5: widen the interval by 5s each time, or
                        // AWS keeps answering "slow down" instead of the token.
                        pollIntervalMs += 5000;
                        log.warn(
                            "[getNewToken] Polling too fast, interval now %sms",
                            pollIntervalMs
                        );
                    } else if (err instanceof AccessDeniedException) {
                        // The user said no at the identity provider.
                        throw new LoginAbortedError(describeError(err), {
                            cause: err,
                            cancelledByUser: true,
                        });
                    } else if (err instanceof ExpiredTokenException) {
                        // The device code is dead, so there is nothing left to poll for.
                        throw new LoginAbortedError(
                            "Login page expired before it was approved",
                            { cause: err }
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
                    throw new LoginAbortedError("Login window closed", {
                        cancelledByUser: true,
                    });
                }
            }
            throw new LoginAbortedError("Login timed out");
    } finally {
        // destroy(), not close(): cleanup must not depend on the remote page
        // agreeing to unload.
        if (window && !window.isDestroyed()) {
            window.destroy();
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
