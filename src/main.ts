import { app } from "electron";
import log from "electron-log";
import updateElectronApp from "update-electron-app";
import { updateTrayIcon } from "./tray";
import { setNextTokenRefresh } from "./aws-sso";
import { config } from "./config";

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

    app.on("window-all-closed", (event: Event) => event.preventDefault());

    setNextTokenRefresh();
    updateTrayIcon();

    app.setLoginItemSettings({
        openAtLogin: true,
    });
}

log.catchErrors({ showDialog: true });

main();
