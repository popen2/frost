import * as path from 'path'
import { app, shell, Menu, Tray } from 'electron'
import log from 'electron-log'
import updateElectronApp from 'update-electron-app'
import prompt from 'electron-prompt'

const TRAY_ICON = path.join(__dirname, 'tray-icon', 'TrayIcon.Template.png')

let tray: Tray | null = null

function setTrayIcon() {
    const menu = Menu.buildFromTemplate([
        {
            label: 'Configure',
            click: configure,
        },
        {
            type: 'separator',
        },
        {
            label: 'About Frost',
            click() {
                shell.openExternal('https://github.com/popen2/frost')
            }
        },
        {
            label: 'Quit',
            click() {
                app.quit()
            },
        },
    ])

    tray = new Tray(TRAY_ICON)
    tray.setContextMenu(menu)
}

async function configure(): Promise<void> {
    let url: string | null = null
    try {
        url = await prompt({
            title: 'Configure AWS SSO',
            label: 'Please enter AWS SSO URL:',
            inputAttrs: {
                type: 'url',
                required: 'true',
            },
            type: 'input',
        })
    } catch (err) {
        log.error(`[configure] Error getting AWS SSO URL: ${err}`)
    }
    if (!url) {
        log.warn('[configure] User cancelled')
        return
    }
}

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

    setTrayIcon()
}

log.catchErrors({ showDialog: true })

main()
