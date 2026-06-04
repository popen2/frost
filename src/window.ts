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
import { runLogEmitter, type RunLog } from "./run-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DashboardState {
    userConfig?: UserConfig;
    isWorking: boolean;
    expiresAt?: string;
    lastError?: string | null;
    profiles: StoredProfile[];
    clusters: { name: string; profile: string; region: string }[];
    lastRun?: RunLog;
    behaviorConfig: BehaviorConfig;
}

export interface IpcCallbacks {
    onSaveSettings: (settings: UserConfig) => void;
    onTriggerRefresh: () => void;
    onSaveBehavior: (behavior: BehaviorConfig) => void;
    onSetHotkeyRecording: (recording: boolean) => void;
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
        lastRun: config.get("lastRun") as RunLog | undefined,
        behaviorConfig:
            (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
            DEFAULT_BEHAVIOR,
    };
}

function pushStateUpdate() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send("state-updated", getState());
    }
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
        callbacks.onSaveBehavior(behavior);
    });

    ipcMain.handle("set-hotkey-recording", (_event, recording: boolean) => {
        callbacks.onSetHotkeyRecording(recording);
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
