import { app, globalShortcut, Notification } from "electron";
import log from "electron-log/main";
import { updateElectronApp } from "update-electron-app";
import { updateTrayIcon } from "./tray.js";
import {
    setNextTokenRefresh,
    refresh,
    hasPendingAuth,
    triggerPendingAuth,
} from "./aws-sso.js";
import {
    config,
    DEFAULT_BEHAVIOR,
    type BehaviorConfig,
} from "./config.js";
import { pruneHistory } from "./run-log.js";
import { openDashboard, setupIpc } from "./window.js";
import { formatHotkey } from "./hotkey.js";
import {
    handleSquirrelStartup,
    setAppUserModelId,
    setOpenAtLogin,
} from "./squirrel.js";
import {
    configureLogging,
    logStartupBanner,
    sweepOldLogs,
} from "./logging.js";

let currentHotkey: string | null = null;
let isRecordingHotkey = false;

function registerHotkey(hotkey: string) {
    if (currentHotkey) {
        globalShortcut.unregister(currentHotkey);
        currentHotkey = null;
    }
    try {
        const ok = globalShortcut.register(hotkey, () => {
            if (isRecordingHotkey) return;
            if (hasPendingAuth()) {
                log.info("[hotkey] Triggering pending auth");
                triggerPendingAuth();
            } else if (!config.get("isWorking")) {
                log.info("[hotkey] Triggering refresh");
                refresh();
            }
        });
        if (ok) {
            currentHotkey = hotkey;
            log.info("[registerHotkey] Registered: %s", hotkey);
        } else {
            log.warn("[registerHotkey] Could not register: %s", hotkey);
        }
    } catch (err) {
        log.error("[registerHotkey] Error registering %s: %s", hotkey, err);
    }
}

async function main() {
    log.info("[main] =================== Starting app ===================");
    logStartupBanner();

    // Squirrel runs the app to have it install/remove its own shortcuts. Those
    // launches must do nothing else and exit, so this comes before any setup.
    if (await handleSquirrelStartup()) {
        log.info("[main] Handled Squirrel event, exiting");
        return;
    }

    // Frost lives in the tray with no window of its own, so on Windows and
    // Linux a second launch would just add a second tray icon nobody asked
    // for. Hand the click to the instance that is already running instead.
    if (!app.requestSingleInstanceLock()) {
        log.info("[main] Another instance is already running, exiting");
        app.quit();
        return;
    }
    app.on("second-instance", () => {
        log.info("[main] Second instance launched, opening dashboard");
        openDashboard();
    });

    setAppUserModelId();
    config.set("isWorking", false);

    // One-time migration: lastRun → runHistory. The key is deleted afterwards so
    // the old run cannot reappear once retention has pruned runHistory empty.
    const oldRun = config.get("lastRun");
    if (oldRun) {
        const existing = config.get("runHistory") as unknown[] | undefined;
        if (!existing?.length) {
            config.set("runHistory", [oldRun]);
        }
        // `lastRun` is no longer part of the schema, so the typed key union
        // rejects it — drop it through an untyped view of the store.
        (config as unknown as { delete: (key: string) => void }).delete(
            "lastRun"
        );
    }

    pruneHistory();
    sweepOldLogs();

    updateElectronApp({
        logger: log,
    });

    await app.whenReady();
    log.debug("[main] App ready");

    if (app.dock) {
        app.dock.hide();
    }

    app.on("window-all-closed", () => {
        if (app.dock) app.dock.hide();
    });

    app.on("will-quit", () => {
        globalShortcut.unregisterAll();
    });

    setupIpc({
        onSaveSettings: (settings) => {
            config.set("userConfig", settings);
            config.delete("accessToken");
            config.delete("expiresAt");
            setNextTokenRefresh();
            // Flip the tray's "Get Started" item to "Settings…" right away
            // rather than waiting for the next 30s tick.
            updateTrayIcon();
        },
        onTriggerRefresh: () => {
            refresh();
        },
        onSaveBehavior: (behavior: BehaviorConfig) => {
            registerHotkey(behavior.refreshHotkey);
        },
        onSetHotkeyRecording: (recording: boolean) => {
            isRecordingHotkey = recording;
        },
        onTestNotification: () => {
            const behavior =
                (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
                DEFAULT_BEHAVIOR;
            new Notification({
                title: "Frost — Test Notification",
                body: `Press ${formatHotkey(
                    behavior.refreshHotkey
                )} to open the AWS login browser.`,
            }).show();
        },
    });

    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;
    registerHotkey(behavior.refreshHotkey);

    setNextTokenRefresh();
    updateTrayIcon(openDashboard);

    setOpenAtLogin(true);
}

// Before startCatching and before main(), so the very first line written -
// including anything the crash handler reports - lands in the dated file with
// the right permissions.
configureLogging();

log.errorHandler.startCatching({ showDialog: true });

main();
