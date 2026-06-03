import * as path from "path";
import { fileURLToPath } from "url";
import { BrowserWindow, ipcMain } from "electron";
import log from "electron-log/main";
import { config, type UserConfig, type StoredProfile } from "./config.js";
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
}

export interface IpcCallbacks {
    onSaveSettings: (settings: UserConfig) => void;
    onTriggerRefresh: () => void;
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
    dashboardWindow = new BrowserWindow({
        width: 820,
        height: 580,
        title: "Frost",
        resizable: true,
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
