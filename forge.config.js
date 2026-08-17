import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "frost";

// The release pipeline stamps the tag into package.json (`npm version
// --no-git-tag-version`) before invoking Forge, so this is the version being
// built. Used to name the Windows installer, which Squirrel does not version
// for us.
const { version } = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

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

// The build workflow downloads this next to forge.config.js right before
// packaging; on Windows the release asset carries an .exe suffix.
const AWS_IAM_AUTHENTICATOR =
    process.platform === "win32"
        ? "aws-iam-authenticator.exe"
        : "aws-iam-authenticator";

// electron-packager spells this `extraResource`, singular. It was
// `extraResources` (electron-builder's spelling) and therefore did nothing:
// the binary only made it into the package because packager copies the whole
// project directory into `resources/app`. That still happens, so the
// authenticator can now be found in either place — see
// findAwsIamAuthenticator() in src/kubeconfig.ts.
const extraResource = [AWS_IAM_AUTHENTICATOR];

// Windows code signing is optional: without a certificate the installer still
// builds, users just get a SmartScreen prompt on first run. Set both variables
// in the environment to sign.
//
// This is maker-squirrel's `windowsSign` (i.e. @electron/windows-sign), not the
// older top-level `certificateFile`/`certificatePassword` pair — those still
// work but electron-winstaller marks them legacy, and `windowsSign` is what
// grows to EV certificates and cloud signing later.
const { WINDOWS_CERTIFICATE_FILE, WINDOWS_CERTIFICATE_PASSWORD } = process.env;
const windowsSigning = WINDOWS_CERTIFICATE_FILE
    ? {
          windowsSign: {
              certificateFile: WINDOWS_CERTIFICATE_FILE,
              certificatePassword: WINDOWS_CERTIFICATE_PASSWORD,
          },
      }
    : {};

export default {
    packagerConfig: {
        name: "Frost",
        // electron-packager appends the per-platform extension: .icns on
        // macOS, .ico on Windows.
        icon: "./src/icons/AppIcon",
        appBundleId: BUNDLE_ID,
        extraResource,
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
        {
            name: "@electron-forge/maker-squirrel",
            platforms: ["win32"],
            // Forge calls this with the architecture being made, which is how
            // the installer filename can carry the real target rather than
            // whatever the runner happens to be.
            config: (arch) => ({
                // `name` and `exe` decide the Application User Model ID that
                // Squirrel stamps onto the Start Menu shortcut
                // (`com.squirrel.<name>.<exe without extension>`). Windows
                // matches toast notifications against that ID, so
                // src/squirrel.ts hard-codes the same value - keep the three
                // in step.
                name: "Frost",
                exe: "Frost.exe",
                setupExe: `Frost-win32-${arch}-${version}.exe`,
                setupIcon: "./src/icons/AppIcon.ico",
                // Shown next to the entry in Add/Remove Programs. Squirrel
                // requires a remote URL here, not a path.
                iconUrl:
                    "https://raw.githubusercontent.com/popen2/frost/main/src/icons/AppIcon.ico",
                // The .exe installer is the only artifact we ship; the .msi
                // Squirrel would otherwise emit is for group-policy
                // deployment and does not auto-update.
                noMsi: true,
                ...windowsSigning,
            }),
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
