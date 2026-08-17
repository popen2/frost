import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { app } from "electron";
import log from "electron-log/main";

/**
 * Application User Model ID. Squirrel stamps
 * `com.squirrel.<name>.<exe without extension>` onto the Start Menu shortcut
 * it creates, and Windows will only show a toast if the running process
 * claims the same ID — otherwise notifications are silently dropped. The two
 * halves come from the maker-squirrel `name`/`exe` settings in
 * forge.config.js; changing either means changing this.
 *
 * `name` carries the architecture for everything but x64, so that a single
 * GitHub release can hold one Squirrel package per architecture without their
 * artifacts colliding (see `squirrelPackageName` in forge.config.js). A build
 * is only ever installed by the package of its own architecture, so
 * `process.arch` reproduces the name the installer used.
 */
const APP_USER_MODEL_ID =
    process.arch === "x64"
        ? "com.squirrel.Frost.Frost"
        : `com.squirrel.Frost-${process.arch}.Frost`;

/**
 * Squirrel installs to `…\Frost\app-<version>\Frost.exe` and puts its own
 * updater one level up, next to the versioned directories. That updater is
 * also the stable path across upgrades, which matters for the login item.
 */
const UPDATE_EXE = resolve(dirname(process.execPath), "..", "Update.exe");
const EXE_NAME = basename(process.execPath);

const isWindows = process.platform === "win32";

function runUpdate(args: string[]): Promise<void> {
    return new Promise((done) => {
        log.info("[runUpdate] %s %s", UPDATE_EXE, args.join(" "));
        try {
            const child = spawn(UPDATE_EXE, args, { detached: true });
            child.once("close", () => done());
            child.once("error", (err) => {
                log.error("[runUpdate] Failed: %s", err);
                done();
            });
        } catch (err) {
            log.error("[runUpdate] Could not spawn %s: %s", UPDATE_EXE, err);
            done();
        }
    });
}

/**
 * Handles the command lines Squirrel invokes the app with around
 * install/update/uninstall.
 *
 * Returns true when the process was launched purely to service one of those
 * events, in which case it has been told to quit and the caller must not
 * start the app up. `--squirrel-firstrun` deliberately returns false: that is
 * Squirrel launching the freshly installed app for real.
 */
export async function handleSquirrelStartup(): Promise<boolean> {
    if (!isWindows || process.argv.length < 2) {
        return false;
    }

    const command = process.argv[1];
    log.info("[handleSquirrelStartup] Command: %s", command);

    switch (command) {
        case "--squirrel-install":
        case "--squirrel-updated":
            // Also re-run on update, because the shortcut points into the
            // versioned directory that just changed.
            await runUpdate(["--createShortcut", EXE_NAME]);
            app.quit();
            return true;

        case "--squirrel-uninstall":
            await runUpdate(["--removeShortcut", EXE_NAME]);
            app.quit();
            return true;

        case "--squirrel-obsolete":
            // The outgoing version, asked to step aside by its replacement.
            app.quit();
            return true;

        default:
            return false;
    }
}

/** Claims the notification identity Squirrel gave the Start Menu shortcut. */
export function setAppUserModelId() {
    if (!isWindows) {
        return;
    }
    log.info("[setAppUserModelId] %s", APP_USER_MODEL_ID);
    app.setAppUserModelId(APP_USER_MODEL_ID);
}

/**
 * Registers Frost to start with the machine.
 *
 * On Windows a Squirrel install lives in a versioned directory, so pointing
 * the registry entry at the current `Frost.exe` would break on the next
 * update. Launching through `Update.exe --processStart` keeps the entry valid
 * because the updater always resolves the newest version for us.
 */
export function setOpenAtLogin(openAtLogin: boolean) {
    if (isWindows && app.isPackaged) {
        app.setLoginItemSettings({
            openAtLogin,
            path: UPDATE_EXE,
            args: ["--processStart", `"${EXE_NAME}"`],
        });
        return;
    }

    app.setLoginItemSettings({ openAtLogin });
}
