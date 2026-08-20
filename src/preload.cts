import { contextBridge, ipcRenderer } from "electron";

/**
 * The dashboard's only way to reach the main process.
 *
 * This file is `.cts` on purpose: the project is ESM, but a sandboxed preload
 * must be CommonJS, and `moduleResolution: NodeNext` emits `.cts` as `.cjs`
 * without a second tsconfig. Keep it that way - renaming it to `.ts` produces
 * an ESM bundle Electron will refuse to load in a sandboxed renderer.
 *
 * Expose named operations, never `ipcRenderer` itself. Handing the renderer the
 * raw object would let any code in the page invoke arbitrary channels, which is
 * most of what context isolation is for.
 */
const frost = {
    getState: () => ipcRenderer.invoke("get-state"),
    saveSettings: (settings: { startUrl: string; region: string }) =>
        ipcRenderer.invoke("save-settings", settings),
    triggerRefresh: () => ipcRenderer.invoke("trigger-refresh"),
    saveBehavior: (behavior: unknown) =>
        ipcRenderer.invoke("save-behavior", behavior),
    clearHistory: () => ipcRenderer.invoke("clear-history"),
    clearBrowsingData: () => ipcRenderer.invoke("clear-browsing-data"),
    setHotkeyRecording: (recording: boolean) =>
        ipcRenderer.invoke("set-hotkey-recording", recording),
    testNotification: () => ipcRenderer.invoke("test-notification"),

    /** Push channel. The callback never sees the Electron event object. */
    onStateUpdated: (callback: (state: unknown) => void) => {
        ipcRenderer.on("state-updated", (_event, state) => callback(state));
    },

    /** The dashboard renders hotkeys and window chrome per platform. */
    platform: process.platform,
};

contextBridge.exposeInMainWorld("frost", frost);
