import { app } from "electron";
import log from "electron-log/main";
import { updateElectronApp } from "update-electron-app";
import { updateTrayIcon } from "./tray.js";
import { setNextTokenRefresh } from "./aws-sso.js";
import { config } from "./config.js";
import { openDashboard, setupIpc } from "./window.js";

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
        // Keep running in the tray when windows are closed.
    });

    setupIpc({
        onSaveSettings: (settings) => {
            config.set("userConfig", settings);
            config.delete("accessToken");
            config.delete("expiresAt");
            setNextTokenRefresh();
        },
        onTriggerRefresh: () => {
            setNextTokenRefresh();
        },
    });

    setNextTokenRefresh();
    updateTrayIcon(openDashboard);

    app.setLoginItemSettings({
        openAtLogin: true,
    });
}

log.errorHandler.startCatching({ showDialog: true });

main();
