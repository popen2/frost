import { SSO } from 'aws-sdk'
import { AccountListType, NextTokenType, ListAccountsResponse, RoleListType } from "aws-sdk/clients/sso"
import log from 'electron-log'
import slugify from 'slugify'
import { config, UserConfig } from './config'
import { writeAwsConfig, writeSsoConfig } from "./aws-config"

const PREDEFINED_SHORT_NAMES: Record<string, string> = {
    'AdministratorAccess': 'admin',
    'Billing': 'billing',
    'DatabaseAdministrator': 'dba',
    'DataScientist': 'datasci',
    'NetworkAdministrator': 'netadmin',
    'PowerUserAccess': 'poweruser',
    'SecurityAudit': 'secaudit',
    'SupportUser': 'support',
    'SystemAdministrator': 'sysadmin',
    'ViewOnlyAccess': 'viewonly',
}

export async function refreshProfiles() {
    log.info('[refreshProfiles] Refreshing profiles')

    const userConfig = config.get('userConfig') as UserConfig
    const accessToken = config.get('accessToken') as string

    const sso = new SSO({ region: userConfig.region })

    const accounts = await getAccounts(sso, accessToken)
    log.info('[refreshProfiles] Accounts: %s', JSON.stringify(accounts))

    const roles = ([] as RoleListType).concat.apply([], await Promise.all(
        accounts.map(
            account => getAccountRoles(sso, accessToken, account.accountId!)
        )
    ))
    log.info('[refreshProfiles] Roles: %s', JSON.stringify(roles))

    const profiles = generateProfiles(userConfig, accounts, roles)
    await writeAwsConfig(profiles)
}

async function getAccounts(sso: SSO, accessToken: string): Promise<AccountListType> {
    let result: AccountListType = []
    let nextToken: NextTokenType | undefined

    do {
        const res: ListAccountsResponse = await sso.listAccounts({
            accessToken,
            nextToken,
        }).promise()
        result = result.concat(res.accountList || [])
        nextToken = res.nextToken
    } while (nextToken)

    return result
}

async function getAccountRoles(sso: SSO, accessToken: string, accountId: string): Promise<RoleListType> {
    let result: RoleListType = []
    let nextToken: NextTokenType | undefined

    do {
        const res = await sso.listAccountRoles({
            accessToken,
            accountId,
            nextToken,
        }).promise()
        result = result.concat(res.roleList || [])
    } while (nextToken)

    return result
}

export interface Profile {
    name: string
    contents: {
        sso_start_url: string
        sso_region: string
        sso_account_id: string
        sso_role_name: string
        region: string
        output: string
    }
}

function generateProfiles(userConfig: UserConfig, accounts: AccountListType, roles: RoleListType): Profile[] {
    const accountIdToName = new Map<string, string>(
        accounts.map(account => [
            account.accountId!,
            shortAccountName(account.accountName!),
        ])
    )

    const accountIdToRegion = new Map<string, string>(
        accounts.map(account => [
            account.accountId!,
            prefferedAccountRegion(account.accountName!) || userConfig.region,
        ])
    )

    return roles.map(
        role => {
            const shortName = accountIdToName.get(role.accountId!)
            const shortRoleName = shortPermissionSetName(role.roleName!)
            return {
                name: `${shortName}-${shortRoleName}`,
                contents: {
                    sso_start_url: userConfig.startUrl,
                    sso_region: userConfig.region,
                    sso_account_id: role.accountId!,
                    sso_role_name: role.roleName!,
                    region: accountIdToRegion.get(role.accountId!),
                    output: 'json',
                },
            } as Profile
        }
    )
}

function shortAccountName(name: string): string {
    const regex = /#([-_a-zA-Z0-9]+)/gm
    const match = regex.exec(name)
    return match ? match[1] : slugify(name, { lower: true })
}

function prefferedAccountRegion(name: string): string | undefined {
    const regex = /@([a-zA-Z]+-[a-zA-Z]+-[0-9]+)/gm
    const match = regex.exec(name)
    return match ? match[1] : undefined
}

function shortPermissionSetName(name: string): string {
    return PREDEFINED_SHORT_NAMES[name] || name
}
