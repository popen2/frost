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
    errorRetryDelayMs,
    LoginAbortedError,
    loginRetryAction,
    loginWasAbandoned,
    nextLoginAttemptDelayMs,
    nextRefreshDelayMs,
    PRESENCE_CHECK_INTERVAL_MS,
    wasCancelledByUser,
} from "./schedule.js";

/**
 * How much of the device code's life has to be left for a login held for an
 * absent user to be worth showing them when they arrive. Below this the page
 * would expire while they were reading it; the attempt that replaces it starts
 * immediately and opens a fresh one.
 */
const HANDOVER_MIN_CODE_LIFE_MS = 60 * 1000;

let timeoutId: NodeJS.Timeout | undefined;
let nextRefreshAt: number | null = null;
let consecutiveFailures = 0;
let pendingAuthResolve: (() => void) | null = null;
let pendingAuthCancel: (() => void) | null = null;

/**
 * The login that replaces one nobody finished, and the earliest it may start.
 * Null when no login is outstanding.
 */
let loginRetry: { nextAttemptAtMs: number } | null = null;
let loginRetryTimer: NodeJS.Timeout | undefined;

/**
 * Shows the login page the running attempt is holding for an absent user, or
 * null when no attempt is holding one. It is what makes a login Frost is sitting
 * on reachable: the user who asks for a refresh — hotkey, tray, dashboard — gets
 * that live page instead of being told a refresh is already in progress, and the
 * tray can say what the run is really waiting for.
 */
let showParkedLogin: (() => void) | null = null;

export function hasPendingAuth(): boolean {
    return pendingAuthResolve !== null;
}

export function triggerPendingAuth() {
    pendingAuthResolve?.();
}

/**
 * Drop a trigger the user never answered, when the run that was waiting on it
 * has ended. Without this `hasPendingAuth()` keeps saying yes, and the next
 * hotkey press resolves a dead wait instead of starting the refresh the user
 * was asking for.
 */
function cancelPendingAuth() {
    pendingAuthCancel?.();
}

function waitForUserTrigger(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const done = () => {
            clearTimeout(tid);
            pendingAuthResolve = null;
            pendingAuthCancel = null;
        };
        const tid = setTimeout(() => {
            done();
            reject(
                new LoginAbortedError(
                    "Timed out waiting for user to trigger auth"
                )
            );
        }, timeoutMs);
        pendingAuthResolve = () => {
            done();
            resolve();
        };
        pendingAuthCancel = () => {
            done();
            reject(new LoginAbortedError("The login ended before you answered"));
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

/** What the tray should say about a login nobody has finished. */
export type LoginRetryStatus = "none" | "replacing" | "waiting-for-user";

/**
 * Whether a login nobody finished is being replaced, and whether that
 * replacement is one only the user can start. The tray says which: "Sign-in
 * needed" on its own read as Frost having given up, which is what it used to do.
 */
export function getLoginRetryStatus(): LoginRetryStatus {
    // A run holding a login for whoever comes back is waiting for them, not
    // merely "Refreshing…".
    if (showParkedLogin) return "waiting-for-user";
    if (!loginRetry) return "none";
    return canRefreshUnattended() || isUserPresent()
        ? "replacing"
        : "waiting-for-user";
}

/**
 * Whether a refresh can get all the way through with nobody at the machine.
 * Automatic approval is what makes that possible; without it the login page is
 * the user's to work through, and an unattended attempt could only ask AWS for
 * a device code it cannot redeem.
 *
 * Notification mode is no longer an exception. It used to wait for the hotkey
 * before anything opened, which nobody was there to press; it now speaks up
 * only when the page turns out to need a person, so a refresh that needs
 * nobody finishes as silently as any other.
 */
function canRefreshUnattended(): boolean {
    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;
    return behavior.autoApprove !== false;
}

/**
 * Whether somebody is at the machine, as far as the platform will say. Read
 * whenever it matters rather than once per run: a ten-minute login can start
 * with nobody there and end with the user watching it.
 *
 * getSystemIdleTime() is unimplemented on some Linux sessions, where it either
 * throws or reports 0. Both read as "here", which keeps the plain behaviour —
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
 * Replace a login nobody finished, without pausing first.
 *
 * Continuous refreshing is the whole premise: a device code AWS has expired is
 * replaced by a live one, for as long as it takes, so credentials are current
 * whether or not anyone is at the machine. Frost used to stop dead here and wait
 * to be asked (#83), which is why an overnight refresh was found in the morning
 * as a notification about a code that had expired in the night.
 *
 * `delayMs` is therefore 0 in every case that matters — the attempt it replaces
 * has just spent the device code's ten-minute life — and the timer doubles as
 * the presence check for the one login Frost cannot attempt alone.
 */
function scheduleLoginRetry(delayMs: number) {
    cancelLoginRetry();
    loginRetry = { nextAttemptAtMs: Date.now() + delayMs };
    armLoginRetryTimer(delayMs);
    log.info("[scheduleLoginRetry] Next login attempt in %sms", delayMs);
}

function armLoginRetryTimer(delayMs: number) {
    if (loginRetryTimer) clearTimeout(loginRetryTimer);
    loginRetryTimer = setTimeout(onLoginRetryDue, Math.max(delayMs, 0));
}

function cancelLoginRetry() {
    if (loginRetryTimer) {
        clearTimeout(loginRetryTimer);
        loginRetryTimer = undefined;
    }
    loginRetry = null;
}

function onLoginRetryDue() {
    if (!loginRetry) return;
    loginRetryTimer = undefined;

    // A run is already going — the manual refresh the user just asked for, say.
    // It clears this retry itself once it commits.
    if (config.get("isWorking")) {
        armLoginRetryTimer(PRESENCE_CHECK_INTERVAL_MS);
        return;
    }

    const action = loginRetryAction({
        nowMs: Date.now(),
        nextAttemptAtMs: loginRetry.nextAttemptAtMs,
        userPresent: isUserPresent(),
        canRefreshUnattended: canRefreshUnattended(),
    });
    if (action === "wait") {
        // Nothing to do but watch for the user. Starting a run to discover that
        // again would only record a failure every half minute.
        armLoginRetryTimer(PRESENCE_CHECK_INTERVAL_MS);
        return;
    }

    log.info("[onLoginRetryDue] Starting the replacement login");
    // Not cancelled here: refresh() does that once it commits to a run, so a
    // run that cannot start yet leaves the retry armed.
    refresh();
}

export async function refresh() {
    log.info("[refresh] Refreshing credentials");

    const userConfig = config.get("userConfig") as UserConfig;
    log.debug("[refresh] userConfig=%s", userConfig);

    if (!userConfig) {
        log.warn("[refresh] Missing user config, cannot refresh credentials");
        // Nothing can be signed in to, so stop replacing the login rather than
        // leaving the tray claiming Frost is about to try again.
        cancelLoginRetry();
        return;
    }

    // A second refresh would overwrite the single current-run slot in run-log,
    // stranding the first run as "in-progress" forever and writing its
    // remaining steps onto the wrong run.
    if (config.get("isWorking")) {
        // Unless the run in progress is holding a login for an absent user: they
        // are evidently back, and the page waiting for them is better than
        // "already in progress" and nothing on screen.
        if (showParkedLogin) {
            log.info("[refresh] Showing the login this run is holding");
            showParkedLogin();
            return;
        }
        log.warn("[refresh] A refresh is already in progress, skipping");
        return;
    }

    // Committed to a run now: whatever a pending login was waiting for, this run
    // supersedes it, and it arms the next one if it fails.
    cancelLoginRetry();

    // When the attempt started, not when it failed: what replaces it is due
    // immediately, and MIN_LOGIN_CYCLE_MS is measured from here.
    const attemptStartedAtMs = Date.now();

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
        scheduleAfterFailure(err, attemptStartedAtMs);
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
function scheduleAfterFailure(err: unknown, attemptStartedAtMs: number) {
    // The token step succeeded and something afterwards (profiles, EKS) did
    // not. The credentials are good, so stay on the ordinary expiry schedule:
    // an error retry here would re-run getNewToken() and put a login page on
    // screen every minute for a failure that has nothing to do with logging in.
    if (hasValidToken()) {
        consecutiveFailures = 0;
        setNextTokenRefresh();
        return;
    }

    // The user ended the login themselves — closed the window, refused the
    // sign-in at the identity provider. That is "not now" from somebody sitting
    // right there, so take them at their word; the next login is the one they
    // ask for. It is the only ending that is not replaced.
    if (wasCancelledByUser(err)) {
        consecutiveFailures = 0;
        cancelTokenRefresh();
        log.warn(
            "[refresh] The user ended the login, waiting for a manual refresh"
        );
        return;
    }

    // Nobody finished the login: it timed out, the device code expired, the page
    // wanted a password with nobody there to type it. Start the next one at
    // once. The device code's own ten-minute life is what paces this — Frost
    // adds no delay of its own, because a gap here is a gap in the credentials.
    if (loginWasAbandoned(err)) {
        // Reaching a login page at all means the AWS calls worked, so an earlier
        // error streak is stale.
        consecutiveFailures = 0;
        cancelTokenRefresh();
        const delayMs = nextLoginAttemptDelayMs({
            attemptStartedAtMs,
            nowMs: Date.now(),
        });
        log.warn(
            "[refresh] Login not completed, replacing it in %sms",
            delayMs
        );
        scheduleLoginRetry(delayMs);
        return;
    }

    // Something failed before any login page opened — no network, an AWS error
    // registering the client. Nothing is on screen to pile up, and it may well
    // fix itself, so back off and retry.
    consecutiveFailures += 1;
    const retryDelayMs = errorRetryDelayMs(consecutiveFailures);
    log.info(
        "[refresh] Failure %s in a row, retrying in %sms",
        consecutiveFailures,
        retryDelayMs
    );
    setNextTokenRefresh(retryDelayMs);
}

async function getNewToken(
    userConfig: UserConfig
): Promise<CreateTokenCommandOutput> {
    config.set("lastError", null);

    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;
    const useBrowser = behavior.loginMethod === "default_browser";
    const silent = behavior.autoApprove !== false;
    const notifyMode = behavior.refreshMode === "notify";

    // Nothing below can get through without the user: either they asked to be
    // notified and press the hotkey first, or automatic approval is off and the
    // login page is theirs to work through. Stop before asking AWS for a device
    // code nobody can redeem; the retry watches for them and starts then.
    if (!canRefreshUnattended() && !isUserPresent()) {
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

    // Notify mode is a promise not to put a login page in front of the user
    // unannounced. When Frost is about to open one either way, that promise is
    // kept here, before anything opens. Under automatic approval there is
    // nothing to announce yet — most refreshes ask the user for nothing at all
    // — so the notification moves to the moment one turns out to need them, in
    // `handOverToUser()` below.
    if (notifyMode && !silent) {
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
    /**
     * Set when the page needs the user and nobody is at the machine: what it
     * would have been shown for, held until somebody turns up (see the poll
     * loop). The attempt stays alive and hidden in the meantime.
     */
    let parkedReason: string | undefined;
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
    const showToUser = (reason: string) => {
        parkedReason = undefined;
        showParkedLogin = null;

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

    /** What is left of the device code's life. After it there is nothing to show. */
    const remainingMs = () => Math.max(tokenExpires.diff(moment()), 0);

    /** Raised once, however many things notice the page needs the user. */
    let asked = false;

    /**
     * Notify mode, under automatic approval: say that this refresh needs a
     * person, and wait for them to say when. Nothing opens until they do — and
     * this notification is the first they hear of the refresh at all, because
     * the ones that need nobody never speak.
     */
    const askThenShow = async (reason: string) => {
        log.info("[getNewToken] Notify mode: asking before showing the login");
        const note = new Notification({
            title: "Frost — Sign-in Needed",
            body: `Your AWS sign-in needs you. Press ${formatHotkey(
                behavior.refreshHotkey
            )} or click here to continue.`,
        });
        note.on("click", () => triggerPendingAuth());
        note.show();

        // Asking for a refresh while this is waiting is the user saying yes:
        // they get this live page rather than "a refresh is already running".
        showParkedLogin = () => triggerPendingAuth();

        try {
            await waitForUserTrigger(remainingMs());
        } catch (err) {
            log.warn(
                "[getNewToken] The sign-in notice went unanswered: %s",
                describeError(err)
            );
            return;
        }
        showToUser(reason);
    };

    /**
     * What the window's drivers call when the page stops being something Frost
     * can get through on its own.
     *
     * With nobody at the machine there is nothing to hand it to: a window shown
     * now, or a tab opened in a browser nobody is looking at, is a login page
     * that expires unseen — an overnight refresh found as a dead page is the
     * whole complaint. So the attempt is held instead, hidden and still being
     * driven, which also leaves room for a slow identity provider to come
     * through on its own. It is shown the moment somebody is there: the poll loop
     * below checks, and so does a refresh the user asks for.
     */
    const handOverToUser = (reason: string) => {
        if (!isUserPresent()) {
            if (parkedReason === undefined) {
                log.info(
                    "[getNewToken] Holding the login for whoever comes back: %s",
                    reason
                );
            }
            parkedReason = reason;
            showParkedLogin = () => showToUser(reason);
            return;
        }

        // Somebody is here, but notify mode asked to be told rather than
        // interrupted. The page stays hidden and driven until they answer.
        if (notifyMode && silent) {
            if (asked) return;
            asked = true;
            void askThenShow(reason);
            return;
        }

        showToUser(reason);
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

                // The page is waiting for somebody and somebody is now here.
                // Hand them the page this attempt already loaded rather than the
                // one after it — but not a device code with seconds left, which
                // would die under their hands; the replacement is immediate, so
                // the next attempt shows them a fresh page instead.
                if (parkedReason !== undefined && isUserPresent()) {
                    const codeLifeLeftMs = tokenExpires.diff(moment());
                    if (codeLifeLeftMs > HANDOVER_MIN_CODE_LIFE_MS) {
                        log.info(
                            "[getNewToken] The user is back, handing over the login"
                        );
                        showToUser(parkedReason);
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
        cancelPendingAuth();
        // Nothing is holding a login any more, whatever happened to this one.
        showParkedLogin = null;
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
