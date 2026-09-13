// Pure scheduling helpers. Deliberately free of electron imports.

export const MIN_REFRESH_DELAY_MS = 500;
/** The first error retry. Each consecutive failure doubles it from here. */
export const ERROR_RETRY_DELAY_MS = 60 * 1000;
/** Ceiling for that doubling, so a long outage settles at half-hourly. */
export const MAX_ERROR_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * The first retry of a login nobody completed. It doubles from here like the
 * error retry, but starts slower and settles slower: an error retry is
 * invisible, while every attempt here may end up putting a login page in front
 * of the user.
 */
export const ABANDONED_LOGIN_RETRY_DELAY_MS = 5 * 60 * 1000;
/** Ceiling for that doubling, so a login left alone all night settles hourly. */
export const MAX_ABANDONED_LOGIN_RETRY_DELAY_MS = 60 * 60 * 1000;

/**
 * How often Frost looks for the user while a login is waiting for them. The
 * backoff above says when to try again regardless; this is what gets a login
 * page up within half a minute of them sitting down, rather than at the end of
 * a backoff that has grown to an hour.
 */
export const PRESENCE_CHECK_INTERVAL_MS = 30 * 1000;

/**
 * How much input idleness means nobody is at the machine. Long enough that
 * reading a page without touching anything still counts as being here; short
 * enough that a refresh coming due after the user has gone home is treated as
 * unattended. Getting it wrong costs little in either direction: the presence
 * check above turns "away" into "here" within half a minute.
 */
export const AWAY_IDLE_SEC = 5 * 60;

/**
 * A login run that ended because nobody completed it: the window was closed, the
 * device code expired, or it timed out waiting for the user.
 */
export class LoginAbortedError extends Error {
    /**
     * True when the user ended it themselves — closed the window, refused the
     * sign-in at the identity provider. That is "not now" from someone who is
     * sitting right there, so Frost stays quiet and stops trying; the passive
     * endings are the ones worth retrying and a word.
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

/**
 * A login that ended because nobody finished it, rather than because the user
 * said no. Nothing is wrong with the configuration and nothing self-heals on
 * its own: what it needs is another attempt, at a moment when someone is there.
 */
export function loginWasAbandoned(err: unknown): boolean {
    return err instanceof LoginAbortedError && !err.cancelledByUser;
}

function backoffMs(
    firstDelayMs: number,
    maxDelayMs: number,
    consecutiveFailures: number
): number {
    const doublings = Math.max(consecutiveFailures, 1) - 1;
    // 2 ** doublings reaches Infinity long before this matters, and Math.min
    // brings it back to the cap.
    return Math.min(firstDelayMs * 2 ** doublings, maxDelayMs);
}

/**
 * Delay before retrying a failed refresh, or undefined to not retry automatically.
 *
 * Never derived from the stored token expiry: a failed run leaves `expiresAt` in
 * the past, which collapses to MIN_REFRESH_DELAY_MS, and that is how one
 * unattended login became dozens of browser tabs overnight (#83).
 *
 * Only the user ending the login themselves stops the retries. A login nobody
 * finished gets the slower backoff above — Frost stopping dead there meant an
 * overnight refresh was found in the morning as a notification pointing at a
 * device code that had expired minutes after it was issued. The caller keeps
 * those attempts silent while nobody is at the machine, so what the backoff
 * paces is login pages, not tabs piling up in an empty room.
 *
 * Everything else backs off as failures repeat. A cause that is not going to fix
 * itself — a start URL in the wrong region, an SSO instance that has been
 * deleted — otherwise asks AWS the same question every minute forever, silently.
 */
export function retryDelayMsAfterError(
    err: unknown,
    consecutiveFailures = 1
): number | undefined {
    if (err instanceof LoginAbortedError) {
        if (err.cancelledByUser) {
            return undefined;
        }
        return backoffMs(
            ABANDONED_LOGIN_RETRY_DELAY_MS,
            MAX_ABANDONED_LOGIN_RETRY_DELAY_MS,
            consecutiveFailures
        );
    }

    return backoffMs(
        ERROR_RETRY_DELAY_MS,
        MAX_ERROR_RETRY_DELAY_MS,
        consecutiveFailures
    );
}

/** What to do about a login that is waiting for the user, checked periodically. */
export type LoginRetryAction =
    /** Try now, and show the login page: someone is there to finish it. */
    | "attended"
    /** Try now without showing anything: it only succeeds if nobody is needed. */
    | "unattended"
    /** Not yet. */
    | "wait";

/**
 * Decide whether a login that nobody completed should be tried again now.
 *
 * Two things can make it time. The user coming back to a machine that needs
 * them is the important one: the backoff may be an hour long by then, and
 * waiting it out would leave them looking at expired credentials with Frost
 * apparently idle. Otherwise the backoff runs its course, and an attempt with
 * nobody there is still worth making — a refresh whose silent approval was
 * beaten by a slow identity provider or a dropped network goes through on the
 * next try, with no one the wiser.
 */
export function loginRetryAction({
    nowMs,
    nextAttemptAtMs,
    userPresent,
    lastAttemptWasUnattended,
}: {
    nowMs: number;
    nextAttemptAtMs: number;
    userPresent: boolean;
    lastAttemptWasUnattended: boolean;
}): LoginRetryAction {
    if (userPresent && lastAttemptWasUnattended) {
        return "attended";
    }
    if (nowMs >= nextAttemptAtMs) {
        return userPresent ? "attended" : "unattended";
    }
    return "wait";
}
