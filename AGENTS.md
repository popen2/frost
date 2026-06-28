# AGENTS.md

Orientation and gotchas for working on Frost. Read this before changing build
config, dependencies, or the release pipeline.

## What this is

Frost is an Electron menu-bar/tray app (an AWS SSO credentials refresher). It
runs **entirely in the Electron main process** — there is no renderer-side
JavaScript bundle. The login window (`src/aws-sso.ts`) just loads a remote AWS
URL. All `src/*.ts` files execute in the main process.

## Commands

This project uses **npm** (`package-lock.json`; CI runs `npm ci`). Do not add a
`yarn.lock`.

- `npm run build` — `tsc` (type-check + emit to `dist/`) then copies tray icons.
- `npm run lint` — ESLint (flat config, see below).
- `npm start` / `npm run package` / `npm run make` — Electron Forge.

`npm run build` and `npm run lint` are the local signal and both run in CI. They
do **not** prove the app launches — see "Verification limits".

## Module system: ESM

The project is **ESM** (`"type": "module"` in package.json, `tsconfig`
`module`/`moduleResolution: NodeNext`). Consequences:

- Relative imports **must** carry a `.js` extension, e.g. `import { config }
  from "./config.js"` (even though the source is `.ts`).
- No `__dirname`/`__filename`. Use
  `path.dirname(fileURLToPath(import.meta.url))` (see `src/tray.ts`).
- `tsconfig` needs an explicit `rootDir` (TypeScript 6 requirement).
- `forge.config.js` and `eslint.config.js` are ESM (`export default` /
  `import`). `process` is a global; no `require`.

## Dependency gotchas

- **AWS SDK v3** (`@aws-sdk/client-*`). The app uses the modular v3 clients
  (`@aws-sdk/client-sso-oidc`, `client-sso`, `client-ec2`, `client-eks`) with
  the command pattern: `client.send(new XxxCommand({...}))`. SSO role
  credentials come from `fromSSO({ profile })` (`@aws-sdk/credential-providers`),
  which reads the `~/.aws/config` profiles and `~/.aws/sso/cache/<sha1(startUrl)>.json`
  token that the app writes (see `aws-config.ts`). Service error types are
  exported classes, so use `err instanceof AuthorizationPendingException`. The
  old `aws-sdk` v2 (CJS, end-of-life) was removed — do not reintroduce it.
- **electron-log v5**: import `electron-log/main` in the main process.
  `log.catchErrors(...)` was removed → `log.errorHandler.startCatching(...)`.
- **update-electron-app v3**: named export — `import { updateElectronApp }`.
- **@kubernetes/client-node v1**, **electron-store v11**, **delay v7**,
  **uuid v14**: all pure ESM. Use named imports for the k8s client
  (`import { KubeConfig }` — there is no default export).
- **ESLint 10**: flat config only. Config lives in `eslint.config.js` using the
  `typescript-eslint` umbrella package + `@eslint/js` (the old `.eslintrc` and
  `@typescript-eslint/{parser,eslint-plugin}` split are gone). The
  `no-unassigned-vars` core rule catches `do/while` pagination loops that never
  reassign their `nextToken` — make sure the loop body assigns
  `nextToken = res.nextToken`.
- **js-yaml v5**: ships its own type definitions, so `@types/js-yaml` was
  dropped. The `dump`/`load` named exports are unchanged from v4, so
  `import * as yaml from "js-yaml"` + `yaml.dump(...)` (see `src/kubeconfig.ts`)
  still works.
- Removed deprecated type stubs: `@types/aws-sdk`, `@types/uuid`, and
  `@types/js-yaml` (the libs ship their own types), and `@types/request` (the
  `request` lib isn't used). `@types/ini` is still required (ini ships no types).
- `axios` is listed as a dependency but is **not imported anywhere** — dead
  weight, safe to drop in a future cleanup.

## AWS IAM Authenticator

The `aws-iam-authenticator` binary is bundled into the app (`extraResources` in
`forge.config.js`) so users don't need the AWS CLI. It is **not** committed —
the build workflow downloads it at build time. The version is pinned as
`AWS_IAM_AUTHENTICATOR_VERSION` in `.github/workflows/build.yaml`. Release
asset naming is `aws-iam-authenticator_<version>_<os>_<arch>` (os: `darwin` |
`linux`; arch: `amd64` | `arm64`). At runtime the path is resolved in
`src/kubeconfig.ts` (overridable via `AWS_IAM_AUTHENTICATOR_PATH`).

## CI / release pipeline

Three workflows, with the matrix build factored out as a reusable workflow:

- **`.github/workflows/build.yaml`** (reusable, `workflow_call`) — the
  darwin/linux × x64/arm64 matrix that checks out, installs, optionally stamps
  a version, builds, downloads the IAM authenticator, sets up the macOS
  signing keychain, and runs either `electron-forge make` (artifact upload) or
  `electron-forge publish` based on the `publish` input. Owns
  `AWS_IAM_AUTHENTICATOR_VERSION` and the matrix definition. Callers should
  pass `secrets: inherit` so it can read `MAC_CERTS`, `APPLE_API_*`, and
  `GITHUB_TOKEN` without re-declaring them.
- **`.github/workflows/ci.yaml`** (🔍 PR Build) runs on **pull requests to
  `main`**. Lints, then calls `build.yaml` with `publish: false` — packages,
  **signs and notarizes** the macOS app, and uploads the distributable zips
  as PR artifacts. Never tags or publishes. Notarization needs the Apple
  secrets, which are only available on same-repo PRs (not forks).
- **`.github/workflows/release.yaml`** (🚀 Release Version) runs on **push to
  `main`**. Lints, auto-bumps a **patch** git tag
  (`anothrNick/github-tag-action`), calls `build.yaml` with `publish: true`
  and the tag as the `version` input, then flips the GitHub release from
  draft to published.

The app version in `package.json` is overwritten in CI from the tag
(`npm version --no-git-tag-version`), so **don't bump it manually**. The build
runner Node version is `NODEJS_VERSION` (declared in each of the three
workflow files — keep them in sync). It must satisfy the toolchain: ESLint 10,
TypeScript 6, Electron 42.

## macOS signing/notarization (Forge 7)

Forge 7 uses `@electron/osx-sign` v1 and `@electron/notarize` v2. In
`forge.config.js`:
- `osxSign` uses `optionsForFile: () => ({ entitlements, hardenedRuntime,
  signatureFlags })` — the old kebab-case keys (`hardened-runtime`,
  `entitlements-inherit`, `signature-flags`) are silently ignored by v1.
- `osxNotarize` uses notarytool API-key auth: `appleApiKey` is the **path** to
  the `.p8` file, plus `appleApiKeyId` and `appleApiIssuer`. The workflow writes
  the key to `~/private_keys/AuthKey_<APPLE_API_KEY>.p8` (so `APPLE_API_KEY` is
  the key ID).

This path requires Apple certs/secrets and only runs in CI on a macOS runner —
it cannot be validated locally.

## Verification limits

This is a GUI Electron app. In headless/sandboxed environments you can run
`npm run build`, `npm run lint`, and isolated Node runtime checks of individual
libraries, but you **cannot** launch the app, run `electron-forge
package/make`, or validate macOS signing/notarization. Treat those as
"verify in CI / on a real desktop" and say so explicitly rather than claiming
the app works. The PR Build workflow (above) is what actually exercises the
packaging/signing/notarization path.
