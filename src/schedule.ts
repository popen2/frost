// Pure scheduling helpers. Deliberately free of electron imports so this file can
// run (and self-check) under plain node: `node dist/schedule.js`.

import assert from "assert";
import { pathToFileURL } from "url";

export const MIN_REFRESH_DELAY_MS = 500;
export const ERROR_RETRY_DELAY_MS = 60 * 1000;

/**
 * A login run that ended because nobody completed it: the window was closed, the
 * device code expired, or it timed out waiting for the user.
 */
export class LoginAbortedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LoginAbortedError";
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
 */
export function retryDelayMsAfterError(err: unknown): number | undefined {
    if (err instanceof LoginAbortedError) {
        return undefined;
    }

    return ERROR_RETRY_DELAY_MS;
}

function demo() {
    const now = Date.parse("2026-08-20T09:00:00.000Z");
    assert.strictEqual(
        nextRefreshDelayMs("2026-08-20T10:00:00.000Z", now),
        60 * 60 * 1000
    );
    // An expiry in the past must not become an immediate, spinning timeout.
    assert.strictEqual(
        nextRefreshDelayMs("2026-08-20T08:00:00.000Z", now),
        MIN_REFRESH_DELAY_MS
    );
    assert.strictEqual(nextRefreshDelayMs(undefined, now), MIN_REFRESH_DELAY_MS);
    assert.strictEqual(
        nextRefreshDelayMs("not-a-date", now),
        MIN_REFRESH_DELAY_MS
    );
    // A login nobody completed must not re-open the login page on its own.
    assert.strictEqual(
        retryDelayMsAfterError(new LoginAbortedError("Login timed out")),
        undefined
    );
    assert.strictEqual(
        retryDelayMsAfterError(new Error("network down")),
        ERROR_RETRY_DELAY_MS
    );
    console.log("schedule self-check OK");
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    demo();
}
