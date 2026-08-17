import * as path from "path";
import { fileURLToPath } from "url";
import { app, BrowserWindow, ipcMain } from "electron";
import log from "electron-log/main";
import {
    config,
    type UserConfig,
    type StoredProfile,
    type BehaviorConfig,
    DEFAULT_BEHAVIOR,
} from "./config.js";
import {
    runLogEmitter,
    pruneHistory,
    clearHistory,
    type RunLog,
} from "./run-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DashboardState {
    userConfig?: UserConfig;
    isWorking: boolean;
    expiresAt?: string;
    lastError?: string | null;
    profiles: StoredProfile[];
    clusters: { name: string; profile: string; region: string }[];
    runHistory: RunLog[];
    behaviorConfig: BehaviorConfig;
}

/**
 * A single refresh writes to the store many times (one per run-log step, plus
 * one per discovered EKS cluster), and each write would otherwise push a full
 * state update to the renderer. Coalesce them so the dashboard re-renders at
 * most once per tick.
 */
const STATE_PUSH_DEBOUNCE_MS = 100;

export interface IpcCallbacks {
    onSaveSettings: (settings: UserConfig) => void;
    onTriggerRefresh: () => void;
    onSaveBehavior: (behavior: BehaviorConfig) => void;
    onSetHotkeyRecording: (recording: boolean) => void;
    onTestNotification: () => void;
}

let dashboardWindow: BrowserWindow | null = null;

function getState(): DashboardState {
    return {
        userConfig: config.get("userConfig") as UserConfig | undefined,
        isWorking: (config.get("isWorking") as boolean) || false,
        expiresAt: config.get("expiresAt") as string | undefined,
        lastError: config.get("lastError") as string | null | undefined,
        profiles: (config.get("profiles") as StoredProfile[]) || [],
        clusters:
            (config.get("clusters") as {
                name: string;
                profile: string;
                region: string;
            }[]) || [],
        runHistory: (config.get("runHistory") as RunLog[]) || [],
        behaviorConfig:
            (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
            DEFAULT_BEHAVIOR,
    };
}

let pushTimer: NodeJS.Timeout | null = null;

function pushStateUpdate() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
        pushTimer = null;
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
            dashboardWindow.webContents.send("state-updated", getState());
        }
    }, STATE_PUSH_DEBOUNCE_MS);
}

export function setupIpc(callbacks: IpcCallbacks) {
    ipcMain.handle("get-state", () => {
        log.debug("[get-state] Returning state to dashboard");
        return getState();
    });

    ipcMain.handle(
        "save-settings",
        (_event, settings: { startUrl: string; region: string }) => {
            log.info(
                "[save-settings] Saving startUrl=%s region=%s",
                settings.startUrl,
                settings.region
            );
            callbacks.onSaveSettings(settings);
        }
    );

    ipcMain.handle("trigger-refresh", () => {
        log.info("[trigger-refresh] Triggered from dashboard");
        callbacks.onTriggerRefresh();
    });

    ipcMain.handle("save-behavior", (_event, behavior: BehaviorConfig) => {
        log.info(
            "[save-behavior] mode=%s hotkey=%s",
            behavior.refreshMode,
            behavior.refreshHotkey
        );
        config.set("behaviorConfig", behavior);
        // Apply the (possibly shortened) retention period immediately rather
        // than waiting for the next refresh to prune.
        pruneHistory();
        callbacks.onSaveBehavior(behavior);
    });

    ipcMain.handle("clear-history", () => {
        log.info("[clear-history] Deleting all run history");
        clearHistory();
    });

    ipcMain.handle("set-hotkey-recording", (_event, recording: boolean) => {
        callbacks.onSetHotkeyRecording(recording);
    });

    ipcMain.handle("test-notification", () => {
        callbacks.onTestNotification();
    });

    config.onDidAnyChange(() => {
        pushStateUpdate();
    });

    runLogEmitter.on("updated", () => {
        pushStateUpdate();
    });
}

export function openDashboard() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.focus();
        return;
    }

    log.info("[openDashboard] Opening dashboard window");
    if (app.dock) app.dock.show();

    dashboardWindow = new BrowserWindow({
        width: 760,
        height: 520,
        minWidth: 620,
        minHeight: 420,
        title: "Frost",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 12, y: 12 },
        center: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    dashboardWindow.loadFile(path.join(__dirname, "dashboard.html"));
    dashboardWindow.on("closed", () => {
        log.info("[openDashboard] Dashboard window closed");
        dashboardWindow = null;
    });
}
