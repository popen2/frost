import * as path from "path";
import { app, shell, Menu, Tray } from "electron";
import log from "electron-log";
import moment from "moment";
import { config, configure } from "./config";
import { refresh } from "./aws-sso";

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

export function updateTrayIcon() {
    if (!tray) {
        log.info("[updateTrayIcon] Creating tray icon");
        tray = new Tray(TRAY_ICON_FULL);
        setInterval(updateTrayIcon, TRAY_UPDATE_INTERVAL_SEC * 1000);
    }

    log.debug("[updateTrayIcon] Updating tray icon");
    const refreshItema = [] as Electron.MenuItemConstructorOptions[];

    const expiresAt = config.get("expiresAt");
    if (expiresAt) {
        const timeUntil = moment(
            expiresAt as string,
            moment.ISO_8601
        ).fromNow();
        refreshItema.push({
            label: `Next refresh ${timeUntil}`,
            enabled: false,
        });
    }

    if (config.get("userConfig")) {
        refreshItema.push({
            label: "Refresh now",
            click() {
                refresh();
            },
        });
    }

    if (refreshItema.length > 0) {
        refreshItema.push({
            type: "separator",
        });
    }

    const menu = Menu.buildFromTemplate([
        ...refreshItema,
        {
            label: "Settings...",
            click: configure,
        },
        {
            type: "separator",
        },
        {
            label: "About Frost",
            click() {
                shell.openExternal("https://github.com/popen2/frost#readme");
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
