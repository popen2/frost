# AGENTS.md

Orientation and gotchas for working on Frost. Read this before changing build
config, dependencies, or the release pipeline.

## What this is

Frost is an Electron menu-bar/tray app (an AWS SSO credentials refresher).
Almost every `src/*.ts` file executes in the **main process** — there is no
bundler. The login window (`src/aws-sso.ts`) just loads a remote AWS URL.

Two files are exceptions, and both are worth knowing about before you touch the
build:

- `src/login-overlay.ts` runs **in the browser**, injected into the login page
  (see "Login window credential overlay"). It has its own compile,
  `tsconfig.overlay.json`, because the main build's ESM output is not
  injectable and its Node types do not belong in a web page; the main
  `tsconfig.json` excludes it so the two cannot fight over `dist/`.
- `src/dashboard.html` is copied verbatim by `npm run build:html` and is
  neither type-checked nor linted (see below).

If you add another copied asset, remember to add its `copyfiles` step to the
`build` script — a missing step only shows up at runtime.

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

## Login window credential overlay

Electron services WebAuthn (`navigator.credentials`) but ships **no UI** for it:
a page waiting for a YubiKey touch renders nothing at all, which is what made
hardware keys look broken (issue #17). `src/login-indicator.ts` fills that gap
for the login window and is wired up in `aws-sso.ts` *before* `loadURL` — only
on the built-in-window path, since the default-browser login mode gets the
browser's own prompts:

- `src/login-overlay.ts` is compiled to `dist/login-overlay.js`, read off disk,
  and injected with `executeJavaScript` on every `dom-ready` — the main frame
  plus any sub-frame reached through `frame-created`, since `executeJavaScript`
  on the `WebContents` only sees the top frame. It wraps `navigator.credentials.{get,create}` and draws a toast for
  as long as a request is pending. It guards itself with a `window` flag, so
  re-injecting into the same document is a no-op.
- Its compile (`tsconfig.overlay.json`) differs from the main one in three ways
  that all matter: `module: ESNext` (NodeNext would append `export {}`, a syntax
  error in an injected classic script), `lib: DOM` + `types: []` (so `document`
  resolves and `process`/`require` do not), and no source map (the output is
  read as text, never loaded as a file). Because it has no imports it stays a
  plain script — adding one would make the emitted file a module and break
  injection, which is the reason `SIGNAL` is duplicated rather than shared.
- The overlay runs in the **page's** JavaScript world (no preload script), so
  its only channel back to the main process is `console.info()` with a magic
  prefix, read via the `console-message` event. Keep `SIGNAL` in the overlay and
  `LOGIN_OVERLAY_SIGNAL` in the indicator in sync. The remote page could forge
  those lines, so nothing security-relevant may ever hang off them — today they
  only pick a window title and bounce the dock icon.
- Because the overlay lands on pages Frost does not control, it avoids
  `innerHTML` and `<style>` elements (CSP / Trusted Types would reject them),
  renders into a closed shadow root, pins its host styles with `!important`, and
  keeps `pointer-events: none` so it can never swallow a click on the page.
- `session.on("select-webauthn-account")` is also registered here. Electron
  **cancels** the request outright when no listener is registered, so without it
  a key holding several discoverable credentials for the same relying party can
  never sign in. The callback must be invoked exactly once on every path.

The overlay is pure browser logic with no Electron imports, so verify changes to
it by running the built `dist/login-overlay.js` through
`new Function("window", source)` with a stub `window` (per "Verification
limits", the app itself cannot be launched here), or by loading it into a
Playwright page — which is also the only way to check it against a page with a
strict CSP or hostile `!important` CSS.

## `~/.aws/config` ownership

`src/aws-config.ts` **merges** into the user's `~/.aws/config` — it must never
rewrite the file wholesale (it's shared with the AWS CLI and with whatever the
user put there by hand, including `[default]`). `mergeAwsConfig()` is a pure
`(existing, profiles) => contents` function:

- Frost's profiles are tagged with a `# frost:managed` comment line right under
  the section header. Only sections carrying that token are rewritten/removed.
- Unmarked sections are preserved **verbatim**, including comments, blank-line
  placement and `[sso-session ...]`/`[services ...]` sections. Comments directly
  above a header travel with that section, so removing a profile doesn't eat the
  user's note about the next one.
- An unmarked `[profile x]` whose keys/values are *exactly* what Frost would
  generate is **adopted** (rewritten with the marker). That's the upgrade path
  from versions that wrote no marker — without it the first refresh after an
  upgrade would duplicate every profile.
- A same-named profile the user wrote themselves is left alone and Frost skips
  its own (logs a warning) rather than clobbering it.
- Writes go through a temp file + `rename`, and are skipped entirely when the
  merged contents are unchanged.

If you change the generated key set in `profiles.ts`, remember adoption compares
the **full** key set — a new key means existing profiles stop matching, and they
will then be skipped as "not ours" rather than adopted.

There is no test runner in this repo. The merge logic is pure and importable, so
verify changes to it with a throwaway Node script against `dist/aws-config.js`
(stub the `electron-log/main` import) rather than trusting `tsc` alone.

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
- **@kubernetes/client-node v2**, **electron-store v11**, **delay v7**,
  **uuid v14**: all pure ESM. Use named imports for the k8s client
  (`import { KubeConfig }` — there is no default export). The v1 → v2 bump
  didn't touch the surface `src/kubeconfig.ts` uses (`loadFromString`,
  `addCluster`/`addUser`/`addContext`, the `clusters`/`users`/`contexts`
  arrays, `exportConfig`) — verified by round-tripping a merge against a
  hand-written kubeconfig. v2 does **not** declare `@types/ws`, but its `.d.ts`
  files reach into `isomorphic-ws` → `ws`, so `@types/ws` must stay a devDep or
  `tsc` fails with TS7016.
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
  `request` lib isn't used). `@types/ini` is still required (ini ships no types),
  and so is `@types/ws` (see the k8s note above).
- `axios` was a dependency that nothing imported — it has been dropped. Don't
  reintroduce it; the app makes no direct HTTP calls of its own.
- **TypeScript stays on 6.x.** TypeScript 7 is out, but `typescript-eslint` 8
  (including its `canary` tag) still declares
  `peerDependencies.typescript: ">=4.8.4 <6.1.0"`, so installing TS 7 fails
  `npm install` with `ERESOLVE` and would take `npm run lint` — a CI gate —
  down with it. Revisit once typescript-eslint ships TS 7 support.
- **No `overrides` block.** package.json used to carry `overrides` for `tar`,
  `tmp`, `form-data` and `undici` to pull vulnerable transitives forward. After
  the Forge 8 upgrade the whole block is gone: `tmp` left the tree entirely and
  the rest now resolve to patched versions on their own. Prefer upgrading the
  parent over adding an override, and re-check `npm audit` with the block empty
  before adding one back.

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
TypeScript 6, Electron 43, and **Node >= 22.12** — `@electron/packager` 20 and
`@electron/osx-sign` 2 both declare that engine floor. `NODEJS_VERSION: 22`
resolves to the latest 22.x, which clears it; don't pin it to an exact 22.x
below 22.12.

## Electron Forge 8 (prerelease — deliberate)

The three `@electron-forge/*` devDeps are pinned to the **exact** version
`8.0.0-alpha.10` (no `^` — a floating range on a prerelease line moves you
across alphas silently). This is not an accident, and downgrading to the 7.x
stable line reintroduces a high-severity advisory:

- Forge 7.11.2 pins `@electron/packager` 18, whose `extract-zip` dependency has
  an unfixable symlink path-traversal advisory (GHSA-jmr9-qjv8-65gv — *every*
  published version is affected). `@electron/packager` 20 replaced it with
  `@electron-internal/extract-zip`, which clears it.
- Pulling packager 20 under Forge 7 via an override **does not work** — it was
  tried and fails at the end of packaging with `TypeError: done is not a
  function`, because packager 20 made its hooks promise-based while Forge 7's
  `sequentialHooks` still passes a callback. Forge 8 is the version that adapted
  to it.
- `electron-forge package` and `electron-forge make` were both run under
  8.0.0-alpha.10 on linux/x64 and succeed; `forge.config.js` needed no changes.

When Forge 8 goes stable, move to `^8.x` and drop this section down to a note.

## macOS signing/notarization (Forge 8)

Forge 8 (via `@electron/packager` 20) uses `@electron/osx-sign` v2 and
`@electron/notarize` v3. Both majors were ESM/Node-floor bumps and left the
option shapes below untouched, so `forge.config.js` reads the same as it did
under Forge 7. In `forge.config.js`:
- `osxSign` uses `optionsForFile: () => ({ entitlements, hardenedRuntime,
  signatureFlags })` — the old kebab-case keys (`hardened-runtime`,
  `entitlements-inherit`, `signature-flags`) are silently ignored.
- `osxNotarize` uses notarytool API-key auth: `appleApiKey` is the **path** to
  the `.p8` file, plus `appleApiKeyId` and `appleApiIssuer`. The workflow writes
  the key to `~/private_keys/AuthKey_<APPLE_API_KEY>.p8` (so `APPLE_API_KEY` is
  the key ID).

This path requires Apple certs/secrets and only runs in CI on a macOS runner —
it cannot be validated locally.

## Verification limits

This is a GUI Electron app. In headless/sandboxed environments you can run
`npm run build`, `npm run lint`, isolated Node runtime checks of individual
libraries, and — given network access to the Electron release downloads —
`electron-forge package`/`make` **for linux** (packaging never opens a window).
You **cannot** launch the app, and you cannot validate macOS
signing/notarization. Treat those as "verify in CI / on a real desktop" and say
so explicitly rather than claiming the app works. The PR Build workflow (above)
is what actually exercises the packaging/signing/notarization path on macOS.
