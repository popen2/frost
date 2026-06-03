import * as path from "path";
import { fileURLToPath } from "url";
import { app, shell, Menu, Tray } from "electron";
import log from "electron-log/main";
import moment from "moment";
import { config } from "./config.js";
import { refresh } from "./aws-sso.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TRAY_ICON_FULL = path.join(
    __dirname,
    "icons",
    "TrayIconFull.Template.png"
);
const TRAY_ICON_EMPTY = path.join(
    __dirname,
    "icons",
    "TrayIconEmpty.Template.png"
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
            label: "Open Dashboard",
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
