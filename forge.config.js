/* global require */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const process = require("process");

const BUNDLE_ID = "frost";

const { APPLE_API_KEY, APPLE_API_ISSUER } = process.env;
const osxNotarize =
    process.platform === "darwin"
        ? {
              appBundleId: BUNDLE_ID,
              appleApiKey: APPLE_API_KEY,
              appleApiIssuer: APPLE_API_ISSUER,
          }
        : undefined;

const extraResources = ["aws-iam-authenticator"];

/* global module */
module.exports = {
    packagerConfig: {
        name: "Frost",
        arch: process.env.ELECTRON_ARCH,
        icon: "./src/icons/AppIcon",
        appBundleId: BUNDLE_ID,
        extraResources,
        out: "./out",
        osxSign: {
            "hardened-runtime": true,
            entitlements: "entitlements.plist",
            "entitlements-inherit": "entitlements.plist",
            "signature-flags": "library",
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
