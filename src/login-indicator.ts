import { app, dialog, BrowserWindow } from "electron";
import log from "electron-log/main";
import { injectIntoEveryFrame, loadPageScript } from "./page-script.js";

/**
 * The overlay is browser code with its own compile (`tsconfig.overlay.json`),
 * which emits a plain script next to the compiled main-process files;
 * `src/page-script.ts` reads it back as a string to inject.
 */
const OVERLAY_SCRIPT = "login-overlay.js";

/** Must match SIGNAL in src/login-overlay.ts. */
const LOGIN_OVERLAY_SIGNAL = "__frost-login-overlay__:";

/** Echoes the toast in src/login-overlay.ts, for the window title. */
const WAITING_TITLES: Record<string, string> = {
    "security-key": "Touch your security key",
    "register-key": "Register your security key",
    passkey: "Confirm with your passkey",
    "register-passkey": "Create your passkey",
    otp: "Watching for your one-time code",
    password: "Looking for a saved login",
};

const DEFAULT_WAITING_TITLE = WAITING_TITLES["security-key"];

interface OverlaySignal {
    state?: string;
    kind?: string;
}

/**
 * Run the overlay at document start, before the page's own scripts.
 *
 * `dom-ready` is far too late for a page that starts listening for the key as
 * it boots — Google's security-key challenge calls
 * `navigator.credentials.get()` from its boot script, so by the time
 * `dom-ready` fires the request is already pending and wrapping
 * `navigator.credentials` no longer sees it. The page then sits there silently,
 * which is exactly the symptom the overlay exists to remove (issue #17).
 *
 * `Page.addScriptToEvaluateOnNewDocument` is the only hook early enough: it
 * runs our source in the page's own world before any script the page ships,
 * and it keeps doing so across the cross-origin hop from AWS to the identity
 * provider — which moves the page to a different renderer process. It needs the
 * debugger, so the login window cannot open DevTools while it is attached — no
 * loss for a window that only ever shows a sign-in page.
 *
 * It covers the top-level document and any frame sharing its process. A
 * cross-origin <iframe> gets its own process and its own CDP target, which this
 * registration does not reach; those are left to the `dom-ready` injection
 * below, which is in time for anything but a request the frame makes as it
 * boots.
 *
 * Two things about this are easy to get wrong, and silently:
 *
 *  - The `Page` domain has to be enabled first. Without it the registration
 *    still resolves, and still does nothing at all.
 *  - There has to be a renderer to talk to. On a window that has not loaded
 *    anything yet the command never resolves — not an error, just a promise
 *    that hangs — which is why the caller loads about:blank first.
 *
 * Best effort: when it cannot be armed the `dom-ready` injection below is still
 * there, and still covers every page that asks for the key after it has loaded.
 */
async function injectAtDocumentStart(
    contents: Electron.WebContents,
    source: string
): Promise<void> {
    try {
        if (!contents.debugger.isAttached()) {
            contents.debugger.attach("1.3");
        }
        await contents.debugger.sendCommand("Page.enable");
        await contents.debugger.sendCommand(
            "Page.addScriptToEvaluateOnNewDocument",
            {
                source,
                // The window is sitting on about:blank right now, and the login
                // page is the *next* document, so this only covers about:blank
                // itself. Harmless, and it keeps the hook honest if that ever
                // stops being true.
                runImmediately: true,
            }
        );
        log.debug("[loginIndicator] Overlay armed at document start");
    } catch (err) {
        log.warn(
            "[loginIndicator] Could not arm the overlay at document start, " +
                "falling back to dom-ready: %s",
            err
        );
    }
}

/**
 * Give the window a renderer for the debugger to reach, without showing the
 * user anything it would not have shown anyway: a new BrowserWindow is blank
 * until the login page loads either way.
 */
async function loadBlank(contents: Electron.WebContents): Promise<boolean> {
    try {
        await contents.loadURL("about:blank");
        return !contents.isDestroyed();
    } catch (err) {
        log.warn("[loginIndicator] Could not load about:blank: %s", err);
        return false;
    }
}

function detachDebugger(contents: Electron.WebContents) {
    try {
        if (!contents.isDestroyed() && contents.debugger.isAttached()) {
            contents.debugger.detach();
        }
    } catch (err) {
        log.debug("[loginIndicator] Could not detach the debugger: %s", err);
    }
}

function describeAccount(
    account: Electron.WebAuthnAccount,
    index: number
): string {
    const name = account.name?.trim();
    const displayName = account.displayName?.trim();
    if (name && displayName && name !== displayName) {
        return `${displayName} (${name})`;
    }
    return name || displayName || `Passkey ${index + 1}`;
}

/**
 * Give the login window the feedback Electron itself does not provide.
 *
 * Electron services `navigator.credentials` requests but renders nothing while
 * they are pending, so a page waiting on a YubiKey touch looks like a page
 * that has hung (issue #17). This wires up two things for the login window:
 *
 *  - `src/login-overlay.ts`, injected into every document the window loads,
 *    which draws a toast while a credential request is in flight and reports
 *    the wait back over the console; the main process turns that into the
 *    window title, a dock bounce, and a log line, so the prompt is noticeable
 *    even when Frost is in the background.
 *  - `select-webauthn-account`, which Electron emits when a key offers several
 *    discoverable credentials. Without a listener Electron cancels the request
 *    outright, so a key holding two AWS credentials could never sign in.
 *
 * Call this before loading the login URL, and only for the login window: the
 * account picker is a session-wide event, and it is unregistered when the
 * window closes so it can never outlive the sign-in it belongs to.
 *
 * `onUserNeeded` is called the first time the page waits on a credential. Under
 * automatic approval (`src/auto-approve.ts`) the window may not be on screen
 * yet, and a key waiting for a touch behind a window nobody can see is the one
 * wait that cannot resolve itself.
 */
export async function attachLoginIndicator(
    window: BrowserWindow,
    onUserNeeded?: (reason: string) => void
) {
    const contents = window.webContents;
    // Held on to now, while the window is alive: by the time `closed` fires,
    // the WebContents is gone and even reading `contents.session` off it
    // throws "Object has been destroyed". The Session itself outlives the
    // window, so the listener below can still be removed from it.
    const session = contents.session;
    const source = loadPageScript(OVERLAY_SCRIPT);

    // First, and awaited: the overlay is only useful if it is running before
    // the login page's own scripts are, and both steps below need to finish
    // before the caller loads that page. Everything after this is wired up
    // synchronously.
    if (source && (await loadBlank(contents))) {
        await injectAtDocumentStart(contents, source);
    }

    if (window.isDestroyed()) {
        log.warn("[loginIndicator] Window went away while arming the overlay");
        return;
    }

    // Injecting again once each document is up covers the case where the
    // document-start hook could not be armed, and the cross-origin <iframe> an
    // identity provider may put the sign-in in: those run in their own process,
    // out of reach of both executeJavaScript on the WebContents and the
    // document-start registration. The overlay no-ops when it lands in a
    // document twice, so the two cannot collide.
    if (source) injectIntoEveryFrame(contents, source, "loginIndicator");

    let waiting = false;
    let bounceId: number | null = null;
    const holdTitle = (event: Electron.Event) => event.preventDefault();

    const startWaiting = (kind: string) => {
        if (waiting || window.isDestroyed()) return;
        waiting = true;
        log.info("[loginIndicator] Login page is waiting for: %s", kind);

        // Before anything else: there is no point titling or bouncing a window
        // that automatic approval has kept off screen.
        onUserNeeded?.("the page is waiting for a security key or passkey");

        // The page keeps setting its own title, so block those updates for as
        // long as ours is the more useful one.
        contents.on("page-title-updated", holdTitle);
        window.setTitle(
            `Frost — ${WAITING_TITLES[kind] || DEFAULT_WAITING_TITLE}`
        );

        // The toast lives inside the window, so if the user has tabbed away,
        // ask for their attention until they come back or the wait ends.
        if (!window.isFocused()) {
            if (app.dock) {
                bounceId = app.dock.bounce("critical");
            } else {
                window.flashFrame(true);
            }
        }
    };

    const stopWaiting = () => {
        if (!waiting) return;
        waiting = false;

        if (bounceId !== null) {
            app.dock?.cancelBounce(bounceId);
            bounceId = null;
        }
        if (window.isDestroyed() || contents.isDestroyed()) return;

        if (!app.dock) window.flashFrame(false);
        contents.off("page-title-updated", holdTitle);
        window.setTitle(contents.getTitle());
    };

    // The overlay has no IPC channel of its own — it runs in the page's world
    // — so it reports waits by logging a prefixed line. Nothing here trusts
    // the payload beyond picking a title: the login page could log the same
    // line itself, and the worst it could do is bounce our dock icon.
    contents.on("console-message", (details) => {
        if (!details.message.startsWith(LOGIN_OVERLAY_SIGNAL)) return;

        let signal: OverlaySignal;
        try {
            signal = JSON.parse(
                details.message.slice(LOGIN_OVERLAY_SIGNAL.length)
            );
        } catch (err) {
            log.warn("[loginIndicator] Unreadable overlay signal: %s", err);
            return;
        }

        if (signal.state === "start") {
            startWaiting(signal.kind || "security-key");
        } else {
            stopWaiting();
        }
    });

    const selectAccount = (
        _event: Electron.Event,
        details: Electron.SelectWebauthnAccountDetails,
        callback: (credentialId?: string | null) => void
    ) => {
        let credentialId: string | null = null;
        try {
            // The picker below is modal and blocks this process, so ask for the
            // window before it opens: a sheet attached to a window that has not
            // been shown yet is a prompt nobody can answer.
            onUserNeeded?.("your security key holds more than one credential");

            const accounts = details.accounts || [];
            log.info(
                "[loginIndicator] Key offered %d credentials for %s",
                accounts.length,
                details.relyingPartyId
            );

            const buttons = accounts.map(describeAccount);
            const options: Electron.MessageBoxSyncOptions = {
                type: "question",
                title: "Frost",
                message: "Choose an account to sign in with",
                detail: `Your security key holds more than one credential for ${details.relyingPartyId}.`,
                buttons: [...buttons, "Cancel"],
                defaultId: 0,
                cancelId: buttons.length,
                normalizeAccessKeys: false,
            };

            // The picker interrupts the sign-in, so keep it attached to the
            // login window (a sheet on macOS) rather than floating loose.
            const choice = window.isDestroyed()
                ? dialog.showMessageBoxSync(options)
                : dialog.showMessageBoxSync(window, options);

            if (choice < buttons.length) {
                credentialId = accounts[choice].credentialId;
            }
        } catch (err) {
            log.error("[loginIndicator] Could not pick a credential: %s", err);
        } finally {
            // Electron keeps the request pending until this is called, so it
            // has to happen on every path — cancelling is better than hanging.
            callback(credentialId);
        }
    };

    session.on("select-webauthn-account", selectAccount);

    // `close`, not `closed`: the debugger has to be let go while the
    // WebContents it is attached to is still there to let go of.
    window.on("close", () => detachDebugger(contents));

    window.on("closed", () => {
        stopWaiting();
        session.off("select-webauthn-account", selectAccount);
    });
}
