import { app, globalShortcut } from "electron";
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
import { openDashboard, setupIpc } from "./window.js";

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
    config.set("isWorking", false);

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
    });

    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;
    registerHotkey(behavior.refreshHotkey);

    setNextTokenRefresh();
    updateTrayIcon(openDashboard);

    app.setLoginItemSettings({
        openAtLogin: true,
    });
}

log.errorHandler.startCatching({ showDialog: true });

main();
