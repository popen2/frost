import AWS from "aws-sdk";
import log from "electron-log/main";
import slugify from "slugify";
import { config, UserConfig } from "./config.js";
import { writeAwsConfig } from "./aws-config.js";

const { SSO } = AWS;

const PREDEFINED_SHORT_NAMES: Record<string, string> = {
    AdministratorAccess: "admin",
    Billing: "billing",
    DatabaseAdministrator: "dba",
    DataScientist: "datasci",
    NetworkAdministrator: "netadmin",
    PowerUserAccess: "poweruser",
    SecurityAudit: "secaudit",
    SupportUser: "support",
    SystemAdministrator: "sysadmin",
    ViewOnlyAccess: "viewonly",
};

export async function refreshProfiles(): Promise<Profile[]> {
    log.info("[refreshProfiles] Refreshing profiles");

    const userConfig = config.get("userConfig") as UserConfig;
    const accessToken = config.get("accessToken") as string;

    const sso = new SSO({ region: userConfig.region });

    const accounts = await getAccounts(sso, accessToken);
    log.info("[refreshProfiles] Accounts: %s", JSON.stringify(accounts));

    const roles = ([] as AWS.SSO.RoleListType).concat.apply(
        [],
        await Promise.all(
            accounts.map((account) =>
                getAccountRoles(sso, accessToken, account.accountId!)
            )
        )
    );
    log.info("[refreshProfiles] Roles: %s", JSON.stringify(roles));

    const profiles = generateProfiles(userConfig, accounts, roles);
    await writeAwsConfig(profiles);
    return profiles;
}

async function getAccounts(
    sso: AWS.SSO,
    accessToken: string
): Promise<AWS.SSO.AccountListType> {
    let result: AWS.SSO.AccountListType = [];
    let nextToken: AWS.SSO.NextTokenType | undefined;

    do {
        const res: AWS.SSO.ListAccountsResponse = await sso
            .listAccounts({
                accessToken,
                nextToken,
            })
            .promise();
        result = result.concat(res.accountList || []);
        nextToken = res.nextToken;
    } while (nextToken);

    return result;
}

async function getAccountRoles(
    sso: AWS.SSO,
    accessToken: string,
    accountId: string
): Promise<AWS.SSO.RoleListType> {
    let result: AWS.SSO.RoleListType = [];
    let nextToken: AWS.SSO.NextTokenType | undefined;

    do {
        const res = await sso
            .listAccountRoles({
                accessToken,
                accountId,
                nextToken,
            })
            .promise();
        result = result.concat(res.roleList || []);
        nextToken = res.nextToken;
    } while (nextToken);

    return result;
}

export interface Profile {
    name: string;
    accountName: string;
    roleName: string;
    contents: {
        sso_start_url: string;
        sso_region: string;
        sso_account_id: string;
        sso_role_name: string;
        region: string;
        output: string;
    };
}

function generateProfiles(
    userConfig: UserConfig,
    accounts: AWS.SSO.AccountListType,
    roles: AWS.SSO.RoleListType
): Profile[] {
    const accountIdToName = new Map<string, string>(
        accounts.map((account) => [
            account.accountId!,
            shortAccountName(account.accountName!),
        ])
    );

    const accountIdToRegion = new Map<string, string>(
        accounts.map((account) => [
            account.accountId!,
            prefferedAccountRegion(account.accountName!) || userConfig.region,
        ])
    );

    return roles.map((role) => {
        const accountName = accountIdToName.get(role.accountId!);
        const roleName = shortPermissionSetName(role.roleName!);
        return {
            name: `${accountName}-${roleName}`,
            accountName,
            roleName,
            contents: {
                sso_start_url: userConfig.startUrl,
                sso_region: userConfig.region,
                sso_account_id: role.accountId!,
                sso_role_name: role.roleName!,
                region: accountIdToRegion.get(role.accountId!),
                output: "json",
            },
        } as Profile;
    });
}

function shortAccountName(name: string): string {
    const regex = /#([-_a-zA-Z0-9]+)/gm;
    const match = regex.exec(name);
    return match ? match[1] : slugify(name, { lower: true });
}

function prefferedAccountRegion(name: string): string | undefined {
    const regex = /@([a-zA-Z]+-[a-zA-Z]+-[0-9]+)/gm;
    const match = regex.exec(name);
    return match ? match[1] : undefined;
}

function shortPermissionSetName(name: string): string {
    return PREDEFINED_SHORT_NAMES[name] || slugify(name, { lower: true });
}
