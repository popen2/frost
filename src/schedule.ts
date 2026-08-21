// Pure scheduling helpers. Deliberately free of electron imports.

export const MIN_REFRESH_DELAY_MS = 500;
/** The first error retry. Each consecutive failure doubles it from here. */
export const ERROR_RETRY_DELAY_MS = 60 * 1000;
/** Ceiling for that doubling, so a long outage settles at half-hourly. */
export const MAX_ERROR_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * A login run that ended because nobody completed it: the window was closed, the
 * device code expired, or it timed out waiting for the user.
 */
export class LoginAbortedError extends Error {
    /**
     * True when the user ended it themselves — closed the window, refused the
     * sign-in at the identity provider. They already know it did not happen, so
     * Frost stays quiet; the passive endings are the ones worth a word.
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
 * Delay before retrying a failed refresh, or undefined to not retry automatically.
 *
 * An aborted login means no human finished the login page, so an automatic retry
 * opens another login page nobody is there to finish. Scheduling that retry off the
 * stale `expiresAt` made the delay collapse to MIN_REFRESH_DELAY_MS, which is how one
 * unattended login became dozens of browser tabs overnight. Those wait for the user to
 * refresh (tray, dashboard, or the hotkey) instead.
 *
 * Everything else backs off as failures repeat. A cause that is not going to fix
 * itself — a start URL in the wrong region, an SSO instance that has been deleted —
 * otherwise asks AWS the same question every minute forever, silently.
 */
export function retryDelayMsAfterError(
    err: unknown,
    consecutiveFailures = 1
): number | undefined {
    if (err instanceof LoginAbortedError) {
        return undefined;
    }

    const doublings = Math.max(consecutiveFailures, 1) - 1;
    // 2 ** doublings reaches Infinity long before this matters, and Math.min
    // brings it back to the cap.
    return Math.min(
        ERROR_RETRY_DELAY_MS * 2 ** doublings,
        MAX_ERROR_RETRY_DELAY_MS
    );
}
