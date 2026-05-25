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
                loginMethod: {
                    type: "string",
                    enum: ["popup", "default_browser"],
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

export type LoginMethod = "popup" | "default_browser";
export const DEFAULT_LOGIN_METHOD: LoginMethod = "popup";

export interface UserConfig {
    startUrl: string;
    region: string;
    loginMethod?: LoginMethod;
}

export function getLoginMethod(userConfig?: UserConfig): LoginMethod {
    if (userConfig?.loginMethod === "default_browser") {
        return "default_browser";
    }

    return DEFAULT_LOGIN_METHOD;
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
