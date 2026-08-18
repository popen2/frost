import { BrowserWindow } from "electron";
import log from "electron-log/main";
import { injectIntoEveryFrame, loadPageScript } from "./page-script.js";

/**
 * The script that does the clicking, compiled by `tsconfig.overlay.json`.
 */
const APPROVE_SCRIPT = "approve-overlay.js";

/** Must match SIGNAL in src/approve-overlay.ts. */
const APPROVE_SIGNAL = "__frost-login-approve__:";

/**
 * How long the flow may go without visible progress — a navigation, a page
 * load, a click — before the window is handed to the user. Long enough to sit
 * through a slow identity provider redirect, short enough that a page we have
 * misread does not look like a hang.
 */
const STALL_MS = 12000;

/**
 * A ceiling on the whole silent attempt, for a page that keeps navigating (a
 * redirect loop, a refreshing "please wait") and so keeps resetting the stall
 * timer for as long as we let it.
 */
const TOTAL_MS = 60000;

/** What the page reported, as a log line and a reason to show the window. */
const REASONS: Record<string, string> = {
    password: "the page is asking for a password",
    input: "the page is asking for something to be typed in",
};

interface ApproveSignal {
    state?: string;
    reason?: string;
    label?: string;
}

/**
 * Drive the AWS SSO device-authorization pages so a refresh with a live
 * federated session needs nothing from the user (issue #1).
 *
 * `src/approve-overlay.ts` is injected into every document the login window
 * loads; it clicks the "Confirm and continue" and "Allow access" steps and
 * reports what it sees. This side turns those reports — plus the window's own
 * navigation events — into a single decision: either the flow is still moving
 * on its own, or the user has to take over, in which case `onUserNeeded` is
 * called exactly once with a short phrase saying why.
 *
 * The caller decides what "take over" means (showing the hidden window, or
 * opening the page in the default browser). Every failure lands there too: an
 * unreadable script, a page that fails to load, a flow that stops making
 * progress. Nothing here can leave the login hidden forever — the timers run
 * whether or not the page ever says anything.
 *
 * Call it before loading the login URL, on a window nothing else has attached
 * to; the listeners go away with the window.
 */
export function attachAutoApprove(
    window: BrowserWindow,
    onUserNeeded: (reason: string) => void
) {
    const contents = window.webContents;

    let settled = false;
    let stallTimer: NodeJS.Timeout | null = null;
    let totalTimer: NodeJS.Timeout | null = null;

    const clearTimers = () => {
        if (stallTimer) clearTimeout(stallTimer);
        if (totalTimer) clearTimeout(totalTimer);
        stallTimer = null;
        totalTimer = null;
    };

    /** The flow is over, one way or another: stop watching it. */
    const settle = () => {
        if (settled) return false;
        settled = true;
        clearTimers();
        return true;
    };

    const handOver = (reason: string) => {
        if (!settle()) return;
        log.info("[autoApprove] Handing the login over: %s", reason);
        onUserNeeded(reason);
    };

    const progress = () => {
        if (settled) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(
            () => handOver("the login page stopped making progress"),
            STALL_MS
        );
    };

    const source = loadPageScript(APPROVE_SCRIPT);
    if (!source) {
        // Without the script there is nothing to drive the page with, and a
        // hidden window would sit there until the device code expired.
        handOver("the approval script could not be read");
        return;
    }

    injectIntoEveryFrame(contents, source, "autoApprove");

    contents.on("console-message", (details) => {
        if (settled) return;
        if (!details.message.startsWith(APPROVE_SIGNAL)) return;

        let signal: ApproveSignal;
        try {
            signal = JSON.parse(details.message.slice(APPROVE_SIGNAL.length));
        } catch (err) {
            log.warn("[autoApprove] Unreadable signal: %s", err);
            return;
        }

        if (signal.state === "clicked") {
            log.info("[autoApprove] Approved a step: %s", signal.label);
            progress();
        } else if (signal.state === "approved") {
            log.info("[autoApprove] The request was approved");
            settle();
        } else if (signal.state === "user") {
            handOver(
                REASONS[signal.reason || ""] || "the page is asking for input"
            );
        }
    });

    // A redirect chain through the identity provider can take a while and says
    // nothing on the console; each hop is progress all the same.
    contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame) progress();
    });

    contents.on(
        "did-fail-load",
        (_event, errorCode, errorDescription, _url, isMainFrame) => {
            if (!isMainFrame) return;
            // -3 is ABORTED, which is what a navigation cancelled by the next
            // navigation reports - routine in a redirect chain.
            if (errorCode === -3) return;
            handOver(`the login page failed to load (${errorDescription})`);
        }
    );

    window.on("closed", clearTimers);

    totalTimer = setTimeout(
        () => handOver("automatic approval ran out of time"),
        TOTAL_MS
    );
    progress();
}
