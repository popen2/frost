import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { app, dialog, BrowserWindow } from "electron";
import log from "electron-log/main";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The overlay is plain browser code, so it is not part of the TypeScript
 * build — `npm run build:overlay` copies it next to the compiled main-process
 * files and we read it back as a string to inject.
 */
const OVERLAY_SCRIPT = path.join(__dirname, "login-overlay.js");

/** Must match SIGNAL in src/login-overlay.js. */
const LOGIN_OVERLAY_SIGNAL = "__frost-login-overlay__:";

/** Echoes the toast in src/login-overlay.js, for the window title. */
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

/** Both `WebContents` and `WebFrameMain` can run a script for us. */
interface ScriptTarget {
    executeJavaScript(code: string): Promise<unknown>;
}

let overlaySource: string | null | undefined;

function loadOverlaySource(): string | null {
    if (overlaySource === undefined) {
        try {
            overlaySource = fs.readFileSync(OVERLAY_SCRIPT, "utf8");
        } catch (err) {
            log.error(
                "[loginIndicator] Could not read %s: %s",
                OVERLAY_SCRIPT,
                err
            );
            overlaySource = null;
        }
    }
    return overlaySource;
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
 *  - `src/login-overlay.js`, injected into every document the window loads,
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
 */
export function attachLoginIndicator(window: BrowserWindow) {
    const contents = window.webContents;
    const source = loadOverlaySource();

    if (source) {
        const inject = (target: ScriptTarget, where: string) => {
            target.executeJavaScript(source).catch((err) => {
                log.debug(
                    "[loginIndicator] Could not inject the overlay into %s: %s",
                    where,
                    err
                );
            });
        };

        contents.on("dom-ready", () => inject(contents, contents.getURL()));

        // A sign-in page may delegate WebAuthn to a cross-origin <iframe> (an
        // identity provider embedded by the AWS page), and executeJavaScript
        // on the WebContents only reaches the top frame — so follow sub-frames
        // as they appear. The overlay no-ops if it lands in a frame twice.
        contents.on("frame-created", (_event, details) => {
            const frame = details.frame;
            if (!frame || frame === contents.mainFrame) return;
            frame.on("dom-ready", () => {
                try {
                    if (!frame.isDestroyed()) inject(frame, frame.url);
                } catch (err) {
                    log.debug(
                        "[loginIndicator] Sub-frame went away before injection: %s",
                        err
                    );
                }
            });
        });
    }

    let waiting = false;
    let bounceId: number | null = null;
    const holdTitle = (event: Electron.Event) => event.preventDefault();

    const startWaiting = (kind: string) => {
        if (waiting || window.isDestroyed()) return;
        waiting = true;
        log.info("[loginIndicator] Login page is waiting for: %s", kind);

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
        if (window.isDestroyed()) return;

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

    contents.session.on("select-webauthn-account", selectAccount);

    window.on("closed", () => {
        stopWaiting();
        contents.session.off("select-webauthn-account", selectAccount);
    });
}
