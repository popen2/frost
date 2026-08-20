import Store from "electron-store";

export const config = new Store({
    /**
     * This file holds the SSO access token - good for every account and
     * permission set the user can reach, for about eight hours - alongside the
     * OIDC client secret and the run history's account inventory. conf defaults
     * to 0o666, which the usual umask turns into 0644, so on any machine with a
     * second account those are readable by anyone logged in.
     *
     * conf writes through `atomically`, which chmods the temp file to exactly
     * this mode before renaming it into place. That means the umask cannot
     * widen it, and existing installations are corrected on the next write
     * rather than only new ones.
     */
    configFileMode: 0o600,

    schema: {
        isWorking: {
            type: "boolean",
        },
        userConfig: {
            type: "object",
            properties: {
                startUrl: {
                    type: "string",
                    format: "uri",
                },
                region: {
                    type: "string",
                },
            },
        },
        expiresAt: {
            type: "string",
            format: "date-time",
        },
        accessToken: {
            type: ["string", "null"],
        },
        ssoClient: {
            type: "object",
            properties: {
                clientName: {
                    type: "string",
                },
                clientId: {
                    type: "string",
                },
                clientSecret: {
                    type: "string",
                },
                issuedAt: {
                    type: "integer",
                },
                expiresAt: {
                    type: "integer",
                },
            },
        },
        lastError: {
            type: ["string", "null"],
        },
        clusters: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                    },
                    profile: {
                        type: "string",
                    },
                    region: {
                        type: "string",
                    },
                },
            },
        },
        profiles: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    accountName: { type: "string" },
                    roleName: { type: "string" },
                    accountId: { type: "string" },
                },
            },
        },
        runHistory: {
            type: "array",
            items: {
                type: "object",
            },
        },
        behaviorConfig: {
            type: "object",
            properties: {
                refreshMode: { type: "string" },
                refreshHotkey: { type: "string" },
                historyRetentionDays: { type: "number" },
                loginMethod: { type: "string" },
            },
        },
    },
});

export interface UserConfig {
    startUrl: string;
    region: string;
}

export interface StoredProfile {
    name: string;
    accountName: string;
    roleName: string;
    accountId: string;
}

export interface BehaviorConfig {
    refreshMode: "auto" | "notify";
    refreshHotkey: string;
    historyRetentionDays: number;
    /**
     * Where the AWS SSO login page opens. The in-app window keeps Frost in
     * front, but the default browser can reach passkeys and password managers.
     */
    loginMethod: "popup" | "default_browser";
}

export const DEFAULT_BEHAVIOR: BehaviorConfig = {
    refreshMode: "auto",
    refreshHotkey: "CmdOrCtrl+Shift+R",
    historyRetentionDays: 7,
    loginMethod: "popup",
};
