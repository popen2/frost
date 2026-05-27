import { homedir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "frost";

const { APPLE_API_KEY, APPLE_API_ISSUER } = process.env;
const osxNotarize =
    process.platform === "darwin"
        ? {
              appleApiKey: join(
                  homedir(),
                  "private_keys",
                  `AuthKey_${APPLE_API_KEY}.p8`
              ),
              appleApiKeyId: APPLE_API_KEY,
              appleApiIssuer: APPLE_API_ISSUER,
          }
        : undefined;

const extraResources = ["aws-iam-authenticator"];

export default {
    packagerConfig: {
        name: "Frost",
        icon: "./src/icons/AppIcon",
        appBundleId: BUNDLE_ID,
        extraResources,
        out: "./out",
        osxSign: {
            optionsForFile: () => ({
                entitlements: "entitlements.plist",
                hardenedRuntime: true,
                signatureFlags: "library",
            }),
        },
        osxNotarize,
        extendInfo: {
            LSUIElement: true,
        },
    },

    makers: [
        {
            name: "@electron-forge/maker-zip",
            platforms: ["darwin", "linux"],
        },
    ],

    publishers: [
        {
            name: "@electron-forge/publisher-github",
            config: {
                repository: {
                    owner: "popen2",
                    name: "frost",
                },
            },
        },
    ],
};
