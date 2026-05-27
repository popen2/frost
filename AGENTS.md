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

- **aws-sdk v2** (CJS, lazy getters). In ESM, `import { EC2 } from "aws-sdk"`
  **fails at runtime** (named exports aren't statically detectable). Use
  `import AWS from "aws-sdk"; const { EC2, EKS, SSO, SSOOIDC, SsoCredentials }
  = AWS;`. For types, reference the namespace: `AWS.EC2.Region`,
  `AWS.SSO.AccountListType`, etc. (Bare subpath type imports like
  `aws-sdk/clients/ec2` need an explicit `.js` under NodeNext because aws-sdk
  has no `exports` map.) aws-sdk v2 is end-of-life; a v3 migration is the real
  long-term fix.
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
- Removed deprecated type stubs: `@types/aws-sdk`, `@types/uuid` (the libs ship
  their own types), and `@types/request` (the `request` lib isn't used).
  `@types/ini` is still required (ini ships no types).
- `axios` is listed as a dependency but is **not imported anywhere** — dead
  weight, safe to drop in a future cleanup.

## AWS IAM Authenticator

The `aws-iam-authenticator` binary is bundled into the app (`extraResources` in
`forge.config.js`) so users don't need the AWS CLI. It is **not** committed —
the release workflow downloads it at build time. The version is pinned in
`.github/workflows/release.yaml` as `AWS_IAM_AUTHENTICATOR_VERSION`. Release
asset naming is `aws-iam-authenticator_<version>_<os>_<arch>` (os: `darwin` |
`linux`; arch: `amd64` | `arm64`). At runtime the path is resolved in
`src/kubeconfig.ts` (overridable via `AWS_IAM_AUTHENTICATOR_PATH`).

## CI / release pipeline

There are two workflows, and they share the same matrix and build steps:

- **`.github/workflows/ci.yaml`** (🔍 PR Build) runs on **pull requests to
  `main`**. It lints, then builds the full matrix (darwin/linux × x64/arm64)
  and runs `electron-forge make` — packaging, **signing and notarizing** the
  macOS app and producing the distributable zips (uploaded as artifacts). It
  does **not** tag or publish. This is the pre-merge "does the whole release
  build actually work" check. Notarization needs the Apple secrets, which are
  only available on same-repo PRs (not forks).
- **`.github/workflows/release.yaml`** (🚀 Release Version) runs on **push to
  `main`**. It lints/builds, auto-bumps a **patch** git tag
  (`anothrNick/github-tag-action`), builds the same matrix but runs
  `electron-forge publish`, and flips the GitHub release from draft to
  published.

The app version in `package.json` is overwritten in CI from the tag
(`npm version --no-git-tag-version`), so **don't bump it manually**. The build
runner Node version is `NODEJS_VERSION` in each workflow (must satisfy the
toolchain: ESLint 10, TypeScript 6, Electron 42). Keep `NODEJS_VERSION` and
`AWS_IAM_AUTHENTICATOR_VERSION` in sync between the two workflows.

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
