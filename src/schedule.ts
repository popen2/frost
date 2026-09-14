// Pure scheduling helpers. Deliberately free of electron imports.

export const MIN_REFRESH_DELAY_MS = 500;
/** The first error retry. Each consecutive failure doubles it from here. */
export const ERROR_RETRY_DELAY_MS = 60 * 1000;
/** Ceiling for that doubling, so a long outage settles at half-hourly. */
export const MAX_ERROR_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * The shortest a login attempt may hold the slot before its replacement starts.
 *
 * Not a backoff: it never grows, and in practice nothing waits for it. AWS's
 * device code lives about ten minutes, so an attempt nobody finishes takes that
 * long to die and the next one begins the moment it does — which is what makes
 * refreshing continuous rather than something that gives up and waits to be
 * asked. This is only a floor against a login that fails the instant it starts
 * (a device authorization AWS rejects outright), which would otherwise spin new
 * attempts as fast as AWS could refuse them.
 */
export const MIN_LOGIN_CYCLE_MS = 30 * 1000;

/**
 * How often Frost looks for the user while holding a sign-in that cannot go
 * anywhere without them — notification mode, or automatic approval turned off.
 * Those cannot be attempted unattended at all, so there is nothing to do but
 * wait for somebody and start the moment they are there.
 */
export const PRESENCE_CHECK_INTERVAL_MS = 30 * 1000;

/**
 * How much input idleness means nobody is at the machine. Long enough that
 * reading a page without touching anything still counts as being here; short
 * enough that a refresh coming due after the user has gone home is treated as
 * unattended. Getting it wrong costs little in either direction: presence is
 * re-read as the login runs, so "away" becomes "here" within a poll.
 */
export const AWAY_IDLE_SEC = 5 * 60;

/**
 * A login run that ended because nobody completed it: the window was closed, the
 * device code expired, or it timed out waiting for the user.
 */
export class LoginAbortedError extends Error {
    /**
     * True when the user ended it themselves — closed the window, refused the
     * sign-in at the identity provider. That is "not now" from somebody sitting
     * right there, so Frost stays quiet and stops; it is the one ending that is
     * not replaced by another attempt.
     */
    readonly cancelledByUser: boolean;

    constructor(
        message: string,
        options?: ErrorOptions & { cancelledByUser?: boolean }
    ) {
        super(message, options);
        this.name = "LoginAbortedError";
        this.cancelledByUser = options?.cancelledByUser ?? false;
    }
}

/** Delay until the next scheduled refresh, based on when the current token expires. */
export function nextRefreshDelayMs(
    expiresAt: string | undefined,
    nowMs: number
): number {
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
    if (Number.isNaN(expiresAtMs)) {
        return MIN_REFRESH_DELAY_MS;
    }

    return Math.max(expiresAtMs - nowMs, MIN_REFRESH_DELAY_MS);
}

/** The user ending the login themselves, which is the one ending Frost obeys. */
export function wasCancelledByUser(err: unknown): boolean {
    return err instanceof LoginAbortedError && err.cancelledByUser;
}

/**
 * A login that ended because nobody finished it, rather than because the user
 * said no. Nothing is wrong with the configuration, so the answer is another
 * attempt — immediately.
 */
export function loginWasAbandoned(err: unknown): boolean {
    return err instanceof LoginAbortedError && !err.cancelledByUser;
}

/**
 * When to start the login that replaces one nobody finished: now, unless the
 * attempt it replaces was short enough for MIN_LOGIN_CYCLE_MS to still apply.
 *
 * Never derived from the stored token expiry, which a failed run leaves in the
 * past: that collapses to MIN_REFRESH_DELAY_MS and starts a whole new login
 * every half second (#83).
 */
export function nextLoginAttemptDelayMs({
    attemptStartedAtMs,
    nowMs,
}: {
    attemptStartedAtMs: number;
    nowMs: number;
}): number {
    return Math.max(attemptStartedAtMs + MIN_LOGIN_CYCLE_MS - nowMs, 0);
}

/**
 * Delay before retrying a run that failed with no login page involved — no
 * network, an AWS error registering the client. Nothing is on screen to pile up
 * and it may well fix itself, so it backs off as failures repeat: a cause that
 * is not going to fix itself (a start URL in the wrong region, an SSO instance
 * that has been deleted) would otherwise ask AWS the same question every minute
 * forever, silently.
 */
export function errorRetryDelayMs(consecutiveFailures = 1): number {
    const doublings = Math.max(consecutiveFailures, 1) - 1;
    // 2 ** doublings reaches Infinity long before this matters, and Math.min
    // brings it back to the cap.
    return Math.min(
        ERROR_RETRY_DELAY_MS * 2 ** doublings,
        MAX_ERROR_RETRY_DELAY_MS
    );
}

/** Whether the login that replaces an unfinished one can start yet. */
export type LoginRetryAction = "go" | "wait";

/**
 * Decide whether to start the next login attempt.
 *
 * Nothing here paces Frost for the sake of pacing: a replacement goes as soon as
 * the last attempt is out of the way. The one thing worth waiting for is the
 * user, and only when Frost cannot make an attempt without them — in
 * notification mode, or with automatic approval off, an unattended attempt would
 * ask AWS for a device code, find nobody to give it to, and record a failed run
 * for it, every time round.
 */
export function loginRetryAction({
    nowMs,
    nextAttemptAtMs,
    userPresent,
    canRefreshUnattended,
}: {
    nowMs: number;
    nextAttemptAtMs: number;
    userPresent: boolean;
    canRefreshUnattended: boolean;
}): LoginRetryAction {
    if (nowMs < nextAttemptAtMs) {
        return "wait";
    }
    if (!userPresent && !canRefreshUnattended) {
        return "wait";
    }
    return "go";
}
