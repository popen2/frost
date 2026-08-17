# AGENTS.md

Orientation and gotchas for working on Frost. Read this before changing build
config, dependencies, or the release pipeline.

## What this is

Frost is an Electron menu-bar/tray app (an AWS SSO credentials refresher). All
`src/*.ts` files execute in the **main process** — there is no renderer-side
build step or bundler. The login window (`src/aws-sso.ts`) just loads a remote
AWS URL.

The one renderer is the dashboard: `src/dashboard.html`, a single self-contained
file (markup, CSS, and inline vanilla JS, no framework) that `npm run build:html`
copies verbatim into `dist/`. It is **not** type-checked or linted — `tsc` and
ESLint only see `src/*.ts` — so changes there are verified by eye and at runtime.
It talks to the main process purely over IPC (`ipcRenderer.invoke` +
a `state-updated` push); the handlers live in `src/window.ts`, which takes an
`IpcCallbacks` object so it never has to import `aws-sso.ts` (that would be a
cycle). It currently runs with `nodeIntegration: true` /
`contextIsolation: false`, so **every value interpolated into `innerHTML` must
go through the `esc()` helper** — account names, cluster names, and error
strings all originate from AWS.

## Commands

This project uses **npm** (`package-lock.json`; CI runs `npm ci`). Do not add a
`yarn.lock`.

- `npm run build` — `tsc` (type-check + emit to `dist/`) then copies the tray
  icons and `src/dashboard.html` into `dist/`.
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
- Removed deprecated type stubs: `@types/aws-sdk`, `@types/uuid` (the libs ship
  their own types), and `@types/request` (the `request` lib isn't used).
  `@types/ini` is still required (ini ships no types).
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

Five workflows, with the matrix build factored out as a reusable workflow:

- **`.github/workflows/build.yaml`** (reusable, `workflow_call`) — the
  darwin/linux × x64/arm64 matrix that checks out, installs, optionally stamps
  a version, builds, downloads the IAM authenticator, sets up the macOS
  signing keychain, and runs either `electron-forge make` (artifact upload) or
  `electron-forge publish` based on the `publish` input. Owns
  `AWS_IAM_AUTHENTICATOR_VERSION` and the matrix definition. Callers should
  pass `secrets: inherit` so it can read `MAC_CERTS`, `APPLE_API_*`, and
  `GITHUB_TOKEN` without re-declaring them.
- **`.github/workflows/ci.yaml`** (🔍 Build) runs on **pull requests to `main`
  and pushes to `main`**. Lints, then calls `build.yaml` with `publish: false`
  — packages, **signs and notarizes** the macOS app, and uploads the
  distributable zips as artifacts. Never tags or publishes. Notarization needs
  the Apple secrets, which are only available on same-repo PRs (not forks). On
  pushes to `main` it also refreshes the release-drafter draft.
- **`.github/workflows/release.yaml`** (🚀 Release Version) runs on **pushed
  `v*` tags** (plus a `workflow_dispatch` fallback). It strips the leading `v`
  and calls `build.yaml` with `publish: true`. It does **not** create the tag:
  release-drafter keeps a draft release up to date, and publishing that draft
  from the GitHub UI is what creates the tag and triggers this workflow.
- **`.github/workflows/pages.yaml`** (🌐 Deploy Pages) publishes `docs/` — the
  marketing site at the project's GitHub Pages URL — on pushes to `main` that
  touch `docs/**`.
- **`.github/workflows/autolabeler.yaml`** (🏷️ Autolabel) applies
  release-drafter's changelog labels to incoming PRs from branch-name patterns.

**Version numbers come from PR labels, not from `package.json`.**
`.github/release-drafter.yml` has a `version-resolver` that reads the labels on
the merged PRs: `major` / `minor` / `patch`, defaulting to **patch**. To cut a
minor release, put the `minor` label on the PR. `autolabeler.yaml` only assigns
the changelog-category labels (`feature` / `fix` / `chore`) and only from
branch-name patterns (`feat/…`, `fix/…`, `chore/…`), so a branch named anything
else — e.g. `claude/…` — needs its labels set by hand.

The app version in `package.json` is overwritten in CI from the tag
(`npm version --no-git-tag-version`), so **don't bump it manually**. The build
runner Node version is `NODEJS_VERSION` (declared in both `ci.yaml` and
`build.yaml` — keep them in sync). It must satisfy the toolchain: ESLint 10,
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
