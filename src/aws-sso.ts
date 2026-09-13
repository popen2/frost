import {
    app,
    BrowserWindow,
    Notification,
    powerMonitor,
    shell,
} from "electron";
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
    AWAY_IDLE_SEC,
    LoginAbortedError,
    loginRetryAction,
    loginWasAbandoned,
    nextRefreshDelayMs,
    PRESENCE_CHECK_INTERVAL_MS,
    retryDelayMsAfterError,
} from "./schedule.js";

let timeoutId: NodeJS.Timeout | undefined;
let nextRefreshAt: number | null = null;
let consecutiveFailures = 0;
let pendingAuthResolve: (() => void) | null = null;

/**
 * A login nobody finished, waiting to be tried again: when the backoff next
 * allows an attempt, and whether the last one ran without showing anything
 * because nobody was at the machine. Null when no login is outstanding.
 */
let loginRetry: {
    nextAttemptAtMs: number;
    lastAttemptWasUnattended: boolean;
} | null = null;
let loginRetryTimer: NodeJS.Timeout | undefined;

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
        // Every refresh Frost starts by itself asks first whether anyone is
        // there: with a live federated session it needs nobody, and if it turns
        // out to need somebody it should not open a login page into an empty
        // room. Only a refresh the user asked for is attended by definition.
        refresh({ attended: isUserPresent() });
    }, timeoutMs);
    log.info("[setNextTokenRefresh] New timeout set to %sms", timeoutMs);
}

/**
 * Stop the ordinary expiry schedule. The tray reads getNextRefreshAt(), so the
 * state this leaves behind is visible rather than silent.
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

/**
 * Epoch ms of the next attempt at a login nobody finished, or null when no
 * login is outstanding. The tray says so: "Sign-in needed" on its own read as
 * Frost having given up, which is exactly what it used to do.
 */
export function getLoginRetryAt(): number | null {
    return loginRetry?.nextAttemptAtMs ?? null;
}

/**
 * Whether somebody is at the machine, as far as the platform will say.
 *
 * getSystemIdleTime() is unimplemented on some Linux sessions, where it either
 * throws or reports 0. Both read as "here", which keeps the old behaviour —
 * Frost opens the login page and lets the user find it — rather than waiting
 * for a signal that is never coming.
 */
function isUserPresent(): boolean {
    try {
        const idleSec = powerMonitor.getSystemIdleTime();
        log.debug("[isUserPresent] System idle for %ss", idleSec);
        return idleSec < AWAY_IDLE_SEC;
    } catch (err) {
        log.warn(
            "[isUserPresent] Could not read the idle time: %s",
            describeError(err)
        );
        return true;
    }
}

/**
 * Keep coming back to a login nobody finished.
 *
 * The tick is short and the decision is in schedule.ts: the backoff says when
 * to try again anyway, and the user turning up says try again now. Frost used to
 * stop dead here and wait to be asked (#83), which is why an overnight refresh
 * was found in the morning as a notification about a device code that had
 * expired in the night.
 */
function scheduleLoginRetry(
    delayMs: number,
    lastAttemptWasUnattended: boolean
) {
    cancelLoginRetry();
    loginRetry = {
        nextAttemptAtMs: Date.now() + delayMs,
        lastAttemptWasUnattended,
    };
    loginRetryTimer = setInterval(onLoginRetryTick, PRESENCE_CHECK_INTERVAL_MS);
    log.info(
        "[scheduleLoginRetry] Trying the login again in %sms, or as soon as the user is back",
        delayMs
    );
}

function cancelLoginRetry() {
    if (loginRetryTimer) {
        clearInterval(loginRetryTimer);
        loginRetryTimer = undefined;
    }
    loginRetry = null;
}

function onLoginRetryTick() {
    if (!loginRetry) return;
    // A run is already going — the manual refresh the user just asked for, say.
    // It clears this retry itself if it gets that far.
    if (config.get("isWorking")) return;

    const action = loginRetryAction({
        nowMs: Date.now(),
        nextAttemptAtMs: loginRetry.nextAttemptAtMs,
        userPresent: isUserPresent(),
        lastAttemptWasUnattended: loginRetry.lastAttemptWasUnattended,
    });
    if (action === "wait") return;

    log.info("[onLoginRetryTick] Retrying the login (%s)", action);
    // Not cancelled here: refresh() does that once it commits to a run, so a
    // run that cannot start yet leaves the retry armed.
    refresh({ attended: action === "attended" });
}

export interface RefreshOptions {
    /**
     * Whether somebody is at the machine to finish a login. An unattended
     * refresh still runs — one with a live federated session needs nobody — but
     * it never puts a login page on screen: it gives up instead and comes back
     * when the user does (see getNewToken and scheduleAfterFailure). Refreshes
     * the user asked for are attended, which is the default.
     */
    attended?: boolean;
}

export async function refresh({ attended = true }: RefreshOptions = {}) {
    log.info("[refresh] Refreshing credentials (attended=%s)", attended);

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

    // Committed to a run now: whatever it was that a pending login was waiting
    // for, this run supersedes it, and it arms a new retry if it fails.
    cancelLoginRetry();

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
            newToken = await getNewToken(userConfig, attended);
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
        scheduleAfterFailure(err, attended);
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
function scheduleAfterFailure(err: unknown, attended: boolean) {
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

    // The user ended the login themselves — closed the window, refused the
    // sign-in at the identity provider. That is "not now" from someone sitting
    // right there, so take them at their word; the next login is the one they
    // ask for.
    if (retryDelayMs === undefined) {
        consecutiveFailures = 0;
        cancelTokenRefresh();
        log.warn(
            "[refresh] The user ended the login, waiting for a manual refresh"
        );
        return;
    }

    const firstFailure = consecutiveFailures === 0;
    consecutiveFailures += 1;

    // Nobody finished the login: it timed out, the device code expired, the page
    // wanted a password with no one there to type it. Frost used to stop here
    // and wait to be asked, which turned a refresh coming due at 3am into
    // expired credentials at 9am. Keep trying instead — on a backoff, and
    // silently while nobody is there — so the user meets a live login page
    // rather than the wreck of one that died in the night.
    if (loginWasAbandoned(err)) {
        cancelTokenRefresh();
        log.warn(
            "[refresh] Login %s not completed (failure %s in a row), retrying in %sms",
            attended ? "was" : "could not be",
            consecutiveFailures,
            retryDelayMs
        );
        // Once per streak, and only when somebody was there to ignore the login:
        // a notification per retry nags all night, and one raised at 3am is just
        // an unread notification in the morning. The retry itself is what the
        // user who was away gets.
        if (firstFailure && attended) {
            notifyLoginNeeded(retryDelayMs);
        }
        scheduleLoginRetry(retryDelayMs, !attended);
        return;
    }

    // Something failed before any login page opened — no network, an AWS error
    // registering the client. Nothing is on screen to pile up, and it may well
    // fix itself, so back off and retry.
    log.info(
        "[refresh] Failure %s in a row, retrying in %sms",
        consecutiveFailures,
        retryDelayMs
    );
    setNextTokenRefresh(retryDelayMs);
}

/**
 * Tell the user, once per streak, that a login they were there for went
 * unfinished — and when Frost will offer it again, since it no longer waits to
 * be asked. The click is the shortcut for not waiting that long.
 */
function notifyLoginNeeded(retryDelayMs: number) {
    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;
    const note = new Notification({
        title: "Frost — Sign-in Needed",
        body: `The AWS login was not completed. Frost will try again in ${moment
            .duration(retryDelayMs)
            .humanize()} — press ${formatHotkey(
            behavior.refreshHotkey
        )} or use the tray to sign in now.`,
    });
    note.on("click", () => refresh());
    note.show();
}

async function getNewToken(
    userConfig: UserConfig,
    attended: boolean
): Promise<CreateTokenCommandOutput> {
    config.set("lastError", null);

    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;
    const useBrowser = behavior.loginMethod === "default_browser";
    const silent = behavior.autoApprove !== false;

    // Nothing below can get through without the user: either they asked to be
    // notified and press the hotkey first, or automatic approval is off and the
    // login page opens for them to work through. Stop before asking AWS for a
    // device code that nobody is going to redeem — the retry will ask for a
    // fresh one when somebody is here.
    if (!attended && (!silent || behavior.refreshMode === "notify")) {
        throw new LoginAbortedError(
            "Nobody is at the machine, and this login needs the user"
        );
    }

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

    /**
     * Why this attempt is over, checked by the poll loop. Undefined for as long
     * as the login is still worth waiting on — which, in default-browser mode,
     * is until the device code expires: there is no window to watch there.
     */
    let abort: LoginAbortedError | undefined;
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
        // Nobody is here. A window shown now, or a tab opened in a browser
        // nobody is looking at, is a login page that expires unseen — and an
        // overnight refresh that ends as a dead page is the whole complaint.
        // End this attempt; the retry brings a fresh page when the user is back.
        if (!attended) {
            log.info(
                "[getNewToken] The login needs the user and nobody is here: %s",
                reason
            );
            abort ??= new LoginAbortedError(
                `Nobody is at the machine, and ${reason}`
            );
            return;
        }

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
                abort ??= new LoginAbortedError("Login window closed", {
                    cancelledByUser: true,
                });
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

                // Closing the window means "I'm not logging in now", and an
                // unattended attempt that turns out to need the user has nothing
                // left to wait for. Give up here rather than waiting for a
                // non-pending token error, which may never come — the run would
                // then hold `isWorking` (and block every new refresh) until the
                // device code expires.
                //
                // This has to come *after* the poll above, not before it. AWS tells
                // the user to close the window as soon as they approve, so between
                // the approval and the next poll the window is usually already
                // gone — and checking first threw away a token that was waiting to
                // be collected.
                if (abort) {
                    log.warn("[getNewToken] Aborting: %s", abort.message);
                    throw abort;
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
