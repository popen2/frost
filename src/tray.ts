import * as path from 'path'
import { app, shell, Menu, Tray } from 'electron'
import moment from 'moment'
import { config, configure } from './config'

const TRAY_ICON = path.join(__dirname, 'icons', 'TrayIcon.Template.png')

let tray: Tray | null = null

export function updateTrayIcon() {
    if (!tray) {
        tray = new Tray(TRAY_ICON)
    }

    const expiresAt = config.get('expiresAt')
    const nextRefreshItems = [] as Electron.MenuItemConstructorOptions[]
    if (expiresAt) {
        const timeUntil = moment(expiresAt as string, moment.ISO_8601).fromNow()
        nextRefreshItems.push({
            label: `Next refresh ${timeUntil}`,
            enabled: false,
        })
        nextRefreshItems.push({
            type: 'separator',
        })
    }

    const menu = Menu.buildFromTemplate([
        ...nextRefreshItems,
        {
            label: 'Settings...',
            click: configure,
        },
        {
            type: 'separator',
        },
        {
            label: 'About Frost',
            click() {
                shell.openExternal('https://github.com/popen2/frost#readme')
            }
        },
        {
            label: 'Quit',
            click() {
                app.quit()
            },
        },
    ])

    tray.setContextMenu(menu)
}
