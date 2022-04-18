import { app } from 'electron'
import log from 'electron-log'
import updateElectronApp from 'update-electron-app'
import { updateTrayIcon } from './tray'
import { setNextTokenRefresh } from './aws-sso'

async function main() {
    log.info('[main] =================== Starting app ===================')

    updateElectronApp({
        logger: log,
    })

    await app.whenReady()
    log.debug('[main] App ready')

    if (app.dock) {
        app.dock.hide()
    }

    app.on('window-all-closed', (event: Event) => event.preventDefault())

    setNextTokenRefresh()
    updateTrayIcon()
}

log.catchErrors({ showDialog: true })

main()
