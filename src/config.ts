import log from 'electron-log'
import prompt from 'electron-prompt'
import Store from 'electron-store'
import { setNextTokenRefresh } from "./aws-sso"

export const config = new Store({
    schema: {
        userConfig: {
            type: 'object',
            properties: {
                startUrl: {
                    type: 'string',
                    format: 'uri',
                },
                region: {
                    type: 'string',
                },
            },
        },
        expiresAt: {
            type: 'string',
            format: 'date-time',
        },
        accessToken: {
            type: ['string', 'null']
        },
        ssoClient: {
            type: 'object',
            properties: {
                clientName: {
                    type: 'string',
                },
                clientId: {
                    type: 'string',
                },
                clientSecret: {
                    type: 'string',
                },
                issuedAt: {
                    type: 'integer',
                },
                expiresAt: {
                    type: 'integer',
                },
            },
        },
    },
})

export interface UserConfig {
    startUrl: string
    region: string
}

export async function configure(): Promise<void> {
    try {
        const startUrl = await prompt({
            title: 'Configure AWS SSO',
            label: 'Please enter AWS SSO URL:',
            inputAttrs: {
                type: 'url',
                required: 'true',
            },
            type: 'input',
            value: config.get('startUrl') as string || '',
        })

        if (!startUrl) {
            log.warn('[configure] User cancelled')
            return
        }

        const region = await prompt({
            title: 'Configure AWS SSO',
            label: 'Please enter AWS SSO region:',
            inputAttrs: {
                type: 'string',
                required: 'true',
            },
            type: 'input',
            value: config.get('region') as string || 'us-east-1',
        })

        if (!region) {
            log.warn('[configure] User cancelled')
            return
        }

        config.set('userConfig', { startUrl, region })
        config.delete('accessToken')
        config.delete('expiresAt')

        setNextTokenRefresh()
    } catch (err) {
        log.error(`[configure] Error getting AWS SSO URL: ${err}`)
    }
}
