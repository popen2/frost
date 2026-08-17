import Store from "electron-store";

export const config = new Store({
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
}

export const DEFAULT_BEHAVIOR: BehaviorConfig = {
    refreshMode: "auto",
    refreshHotkey: "CmdOrCtrl+Shift+R",
    historyRetentionDays: 7,
};
