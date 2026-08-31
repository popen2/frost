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
import { clearBrowsingData } from "./browsing-data.js";
import {
    runLogEmitter,
    pruneHistory,
    clearHistory,
    type RunLog,
} from "./run-log.js";
import { describeError, sweepOldLogs } from "./logging.js";

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

/**
 * Whether an IPC call came from the dashboard's own top-level frame.
 *
 * Nothing else can reach these handlers as things stand: the login window has
 * no preload script and runs with context isolation, so the AWS and identity
 * provider pages it renders have no `ipcRenderer` at all. The check is here so
 * that stays true by construction - the contextIsolation migration will add a
 * preload bridge, and a bridge that arrives later inherits this rather than
 * needing someone to remember it.
 */
function isFromDashboard(
    event: Electron.IpcMainInvokeEvent,
    channel: string
): boolean {
    const sender = event.senderFrame;
    if (
        dashboardWindow &&
        !dashboardWindow.isDestroyed() &&
        sender &&
        sender === dashboardWindow.webContents.mainFrame
    ) {
        return true;
    }

    log.warn(
        "[ipc] Ignoring %s from an unexpected frame: %s",
        channel,
        sender?.url ?? "<gone>"
    );
    return false;
}

function handleFromDashboard<A extends unknown[]>(
    channel: string,
    listener: (...args: A) => unknown
) {
    ipcMain.handle(channel, (event, ...args) => {
        if (!isFromDashboard(event, channel)) {
            // Thrown rather than returned: invoke() rejects in the renderer, so
            // a caller that reads a result - save-settings answers {ok} - can
            // never read a refusal as success.
            throw new Error(`${channel} is not available from this window`);
        }
        return listener(...(args as A));
    });
}

export function setupIpc(callbacks: IpcCallbacks) {
    handleFromDashboard("get-state", () => {
        log.debug("[get-state] Returning state to dashboard");
        return getState();
    });

    handleFromDashboard(
        "save-settings",
        (settings: { startUrl?: unknown; region?: unknown }) => {
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

    handleFromDashboard("trigger-refresh", () => {
        log.info("[trigger-refresh] Triggered from dashboard");
        callbacks.onTriggerRefresh();
    });

    handleFromDashboard("save-behavior", (behavior: BehaviorConfig) => {
        log.info(
            "[save-behavior] mode=%s hotkey=%s loginMethod=%s autoApprove=%s",
            behavior.refreshMode,
            behavior.refreshHotkey,
            behavior.loginMethod,
            behavior.autoApprove
        );
        config.set("behaviorConfig", behavior);
        // Apply the (possibly shortened) retention period immediately rather
        // than waiting for the next refresh to prune. Log files are kept for
        // the same period, so they are swept on the same setting.
        pruneHistory();
        sweepOldLogs();
        callbacks.onSaveBehavior(behavior);
    });

    handleFromDashboard("clear-history", () => {
        log.info("[clear-history] Deleting all run history");
        clearHistory();
    });

    handleFromDashboard("clear-browsing-data", async () => {
        try {
            await clearBrowsingData();
            return { ok: true };
        } catch (err) {
            // Answered rather than thrown so the dashboard can say why.
            const described = describeError(err);
            log.error("[clear-browsing-data] Failed: %s", described);
            return { ok: false, error: described };
        }
    });

    handleFromDashboard("set-hotkey-recording", (recording: boolean) => {
        callbacks.onSetHotkeyRecording(recording);
    });

    handleFromDashboard("test-notification", () => {
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
            // The renderer gets no Node and no direct ipcRenderer; everything
            // it can do is the named surface in preload.cts. `.cjs` because a
            // sandboxed preload must be CommonJS - see that file.
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    dashboardWindow.loadFile(path.join(__dirname, "dashboard.html"));
    dashboardWindow.on("closed", () => {
        log.info("[openDashboard] Dashboard window closed");
        dashboardWindow = null;
    });
}
