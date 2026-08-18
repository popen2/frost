import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import log from "electron-log/main";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loading and injecting the scripts that run **in** the login page rather than
 * in the main process (`src/login-overlay.ts`, `src/approve-overlay.ts`).
 *
 * Those have their own compile (`tsconfig.overlay.json`), which emits plain
 * scripts next to the compiled main-process files; we read one back as a string
 * and hand it to `executeJavaScript`. Both of the callers here need the same
 * two things, and neither is obvious:
 *
 * -   The source is read once and remembered, including the failure. A missing
 *     file is a broken build, not a transient error, and re-reading it on every
 *     page load would only repeat the same log line.
 * -   Injection has to follow sub-frames. `executeJavaScript` on a
 *     `WebContents` reaches the top frame only, and a sign-in page routinely
 *     puts the part we care about in a cross-origin `<iframe>`.
 */
const sources = new Map<string, string | null>();

export function loadPageScript(fileName: string): string | null {
    const cached = sources.get(fileName);
    if (cached !== undefined) return cached;

    let source: string | null = null;
    try {
        source = fs.readFileSync(path.join(__dirname, fileName), "utf8");
    } catch (err) {
        log.error("[pageScript] Could not read %s: %s", fileName, err);
    }

    sources.set(fileName, source);
    return source;
}

/** Both `WebContents` and `WebFrameMain` can run a script for us. */
interface ScriptTarget {
    executeJavaScript(code: string): Promise<unknown>;
}

/**
 * Run `source` in every document the window loads, main frame and sub-frames
 * alike, for as long as the window lives. The scripts guard themselves with a
 * `window` flag, so landing in the same document twice is a no-op.
 */
export function injectIntoEveryFrame(
    contents: Electron.WebContents,
    source: string,
    tag: string
) {
    const inject = (target: ScriptTarget, where: string) => {
        target.executeJavaScript(source).catch((err) => {
            log.debug("[%s] Could not inject into %s: %s", tag, where, err);
        });
    };

    contents.on("dom-ready", () => inject(contents, contents.getURL()));

    contents.on("frame-created", (_event, details) => {
        const frame = details.frame;
        if (!frame || frame === contents.mainFrame) return;
        frame.on("dom-ready", () => {
            try {
                if (!frame.isDestroyed()) inject(frame, frame.url);
            } catch (err) {
                log.debug(
                    "[%s] Sub-frame went away before injection: %s",
                    tag,
                    err
                );
            }
        });
    });
}
