import * as path from "path";
import { fileURLToPath } from "url";
import { app, shell, Menu, Tray } from "electron";
import log from "electron-log/main";
import moment from "moment";
import { config } from "./config.js";
import { refresh } from "./aws-sso.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * macOS renders *template* images — a black shape plus alpha — as a mask,
 * inverting them to suit a light or dark menu bar. Windows draws whatever it
 * is given, so the same file would be a black-on-black smudge in the default
 * taskbar. Windows therefore gets the app badge (a white snowflake on blue),
 * which stays legible against either taskbar theme.
 */
const TRAY_ICON_SUFFIX =
    process.platform === "win32" ? ".png" : ".Template.png";

const TRAY_ICON_FULL = path.join(
    __dirname,
    "icons",
    `TrayIconFull${TRAY_ICON_SUFFIX}`
);
const TRAY_ICON_EMPTY = path.join(
    __dirname,
    "icons",
    `TrayIconEmpty${TRAY_ICON_SUFFIX}`
);
const TRAY_UPDATE_INTERVAL_SEC = 30;

let tray: Tray;
let openDashboardCallback: (() => void) | undefined;

export function updateTrayIcon(onOpenDashboard?: () => void) {
    if (onOpenDashboard) {
        openDashboardCallback = onOpenDashboard;
    }

    if (!tray) {
        log.info("[updateTrayIcon] Creating tray icon");
        tray = new Tray(TRAY_ICON_FULL);
        tray.setToolTip("Frost");
        // On macOS a tray click opens the context menu on its own. Windows and
        // Linux reserve the left click for the app, and a tray icon that does
        // nothing when clicked reads as broken — so open the dashboard.
        if (process.platform !== "darwin") {
            tray.on("click", () => openDashboardCallback?.());
        }
        setInterval(updateTrayIcon, TRAY_UPDATE_INTERVAL_SEC * 1000);
    }

    log.debug("[updateTrayIcon] Updating tray icon");
    const refreshItems = [] as Electron.MenuItemConstructorOptions[];

    const expiresAt = config.get("expiresAt");
    if (expiresAt) {
        const timeUntil = moment(
            expiresAt as string,
            moment.ISO_8601
        ).fromNow();
        refreshItems.push({
            label: `Next refresh ${timeUntil}`,
            enabled: false,
        });
    }

    if (config.get("userConfig")) {
        refreshItems.push({
            label: "Refresh now",
            click() {
                refresh();
            },
        });
    }

    if (refreshItems.length > 0) {
        refreshItems.push({
            type: "separator",
        });
    }

    const menu = Menu.buildFromTemplate([
        ...refreshItems,
        {
            // Trailing ellipsis per platform convention: the item opens a
            // window rather than acting immediately. Before Frost is
            // configured there is nothing to change yet, so it invites setup.
            label: config.get("userConfig") ? "Settings…" : "Get Started",
            click() {
                openDashboardCallback?.();
            },
        },
        {
            type: "separator",
        },
        {
            label: "About Frost",
            click() {
                shell.openExternal("https://popen2.github.io/frost/");
            },
        },
        {
            label: "Quit",
            click() {
                app.quit();
            },
        },
    ]);

    tray.setImage(config.get("isWorking") ? TRAY_ICON_EMPTY : TRAY_ICON_FULL);
    tray.setContextMenu(menu);
}
