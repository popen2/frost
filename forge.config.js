import { readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const BUNDLE_ID = "frost";

// The release pipeline stamps the tag into package.json (`npm version
// --no-git-tag-version`) before invoking Forge, so this is the version being
// built. Used to name the Windows installer, which Squirrel does not version
// for us.
const { version } = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

// Signing is opt-in through the environment, the same way windowsSign is below.
// Pull request validation builds deliberately run without the Developer ID in
// the keychain (see `sign` in .github/workflows/build.yaml), and
// @electron/osx-sign fails the build outright rather than skipping when asked
// to sign with an identity that is not there - so the options have to be left
// off entirely, not left half-configured.
const { APPLE_API_KEY, APPLE_API_ISSUER, FROST_SIGN } = process.env;
const signMac = process.platform === "darwin" && FROST_SIGN === "true";

const macSigning = signMac
    ? {
          osxSign: {
              optionsForFile: () => ({
                  entitlements: "entitlements.plist",
                  hardenedRuntime: true,
                  signatureFlags: "library",
              }),
          },
          osxNotarize: {
              appleApiKey: join(
                  homedir(),
                  "private_keys",
                  `AuthKey_${APPLE_API_KEY}.p8`
              ),
              appleApiKeyId: APPLE_API_KEY,
              appleApiIssuer: APPLE_API_ISSUER,
          },
      }
    : {};

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

/**
 * The Squirrel package id, which is what every artifact name derives from:
 * `<id>-<version>-full.nupkg` and the entry inside `RELEASES`.
 *
 * A single GitHub release holds every architecture, so those names have to
 * differ or the second upload to publish would clobber the first and hand one
 * architecture the other's payload on the next auto-update. Squirrel parses
 * `<id>-<version>-full.nupkg` with the version in a fixed position, so the
 * architecture has to live in the **id** — `Frost-arm64-1.2.3-full.nupkg`
 * parses, `Frost-1.2.3-arm64-full.nupkg` does not.
 *
 * x64 deliberately keeps the bare `Frost`. update.electronjs.org looks for
 * `RELEASES-<arch>` and falls back to plain `RELEASES`, so leaving the common
 * architecture unsuffixed means it needs no per-arch asset and its artifact
 * names stay identical to what a single-architecture build produces. Once x64
 * has shipped, changing its id would strand installed clients on a feed whose
 * package no longer matches, so treat it as fixed.
 */
function squirrelPackageName(arch) {
    return arch === "x64" ? "Frost" : `Frost-${arch}`;
}

export default {
    packagerConfig: {
        name: "Frost",
        // electron-packager appends the per-platform extension: .icns on
        // macOS, .ico on Windows.
        icon: "./src/icons/AppIcon",
        appBundleId: BUNDLE_ID,
        extraResource,
        out: "./out",
        ...macSigning,
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
                // src/squirrel.ts derives the same value - keep the two in
                // step.
                name: squirrelPackageName(arch),
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

    // No `publishers`. The release workflow runs `electron-forge make` and
    // uploads out/make with `gh release upload` — see the "Upload to release"
    // step in .github/workflows/build.yaml for why the GitHub publisher is not
    // usable here.

    hooks: {
        /**
         * Squirrel always names its update manifest `RELEASES`, so every
         * Windows architecture would upload a file by that name into the same
         * GitHub release and the last one would win. Give the non-x64 builds
         * the `RELEASES-<arch>` name that update.electronjs.org looks for
         * first; x64 keeps the plain `RELEASES` it already publishes, which is
         * also the name the service falls back to.
         *
         * The file's contents need no editing: it points at
         * `<id>-<version>-full.nupkg`, and the id already carries the
         * architecture (see squirrelPackageName).
         *
         * The rename on disk is what the upload picks up (it walks `out/make`),
         * but postMake is a mutating hook whose return value is the artifact
         * list Forge reports, so the renamed path goes back into `artifacts`
         * too rather than leaving the two out of step.
         */
        async postMake(_forgeConfig, makeResults) {
            return Promise.all(
                makeResults.map(async (result) => {
                    if (result.platform !== "win32" || result.arch === "x64") {
                        return result;
                    }

                    const artifacts = await Promise.all(
                        result.artifacts.map(async (artifact) => {
                            if (basename(artifact) !== "RELEASES") {
                                return artifact;
                            }
                            const renamed = join(
                                dirname(artifact),
                                `RELEASES-${result.arch}`
                            );
                            await rename(artifact, renamed);
                            return renamed;
                        })
                    );

                    return { ...result, artifacts };
                })
            );
        },
    },
};
