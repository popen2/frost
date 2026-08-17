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
import { validateUserConfig } from "./user-config.js";
import {
    runLogEmitter,
    pruneHistory,
    clearHistory,
    type RunLog,
} from "./run-log.js";
import { sweepOldLogs } from "./logging.js";

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
        (_event, settings: { startUrl?: unknown; region?: unknown }) => {
            // Validate here rather than trusting the form. These two values
            // pick the endpoint every SSO and SSO-OIDC client talks to, and a
            // bad one otherwise surfaces several steps later as a raw SDK
            // error in the Credentials panel.
            const problem = validateUserConfig(settings);
            if (problem) {
                log.warn(
                    "[save-settings] Rejected startUrl=%s region=%s: %s",
                    settings.startUrl,
                    settings.region,
                    problem
                );
                return { ok: false, error: problem };
            }

            const clean: UserConfig = {
                startUrl: (settings.startUrl as string).trim(),
                region: settings.region as string,
            };
            log.info(
                "[save-settings] Saving startUrl=%s region=%s",
                clean.startUrl,
                clean.region
            );
            callbacks.onSaveSettings(clean);
            return { ok: true };
        }
    );

    ipcMain.handle("trigger-refresh", () => {
        log.info("[trigger-refresh] Triggered from dashboard");
        callbacks.onTriggerRefresh();
    });

    ipcMain.handle("save-behavior", (_event, behavior: BehaviorConfig) => {
        log.info(
            "[save-behavior] mode=%s hotkey=%s loginMethod=%s",
            behavior.refreshMode,
            behavior.refreshHotkey,
            behavior.loginMethod
        );
        config.set("behaviorConfig", behavior);
        // Apply the (possibly shortened) retention period immediately rather
        // than waiting for the next refresh to prune. Log files are kept for
        // the same period, so they are swept on the same setting.
        pruneHistory();
        sweepOldLogs();
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
        height: 620,
        minWidth: 620,
        minHeight: 500,
        title: "Frost",
        // The inset traffic lights are a macOS affordance. On Windows
        // `hiddenInset` degrades to `hidden`, which takes the title bar away
        // without putting the minimise/maximise/close buttons anywhere — the
        // window ends up closable only with Alt+F4. Everywhere else keeps the
        // native frame; dashboard.html drops its drag strip to match.
        ...(process.platform === "darwin"
            ? {
                  titleBarStyle: "hiddenInset" as const,
                  trafficLightPosition: { x: 12, y: 12 },
              }
            : {}),
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
