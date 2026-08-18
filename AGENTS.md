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

It ships for **macOS, Windows and Linux** — see "Cross-platform gotchas" below
before touching window chrome, tray icons, or anything path-shaped.

Five small modules exist because they hold a decision that is easy to undo by
accident. Prefer them over doing the thing inline:

- **`src/atomic-write.ts`** — `writeFilePreservingMode()` for files the user
  co-owns (`~/.aws/config`, `~/.kube/config`). Never hand-roll temp-file +
  rename: the rename replaces the *inode*, which drops the destination's mode,
  its owner, and its identity as a symlink — a config symlinked into a dotfiles
  repo gets replaced by a regular file. `atomically` handles all of that plus
  the fsync and the Windows EPERM/EBUSY retry. Anything that must be 0600
  whatever it replaces (the SSO token cache) calls `atomically` directly.
- **`src/logging.ts`** — transport configuration, the retention sweep, and
  `describeError()`. Log errors through `describeError()`: `${err}` throws away
  the AWS SDK's exception name, HTTP status and request id.
- **`src/user-config.ts`** — `validateUserConfig()`, kept out of `config.ts`
  because importing that constructs the electron-store and so needs a live
  Electron app.
- **`src/run-log.ts`** — the per-run step log the Activity panel renders. One
  run is in flight at a time; `refresh()` guards on `isWorking` because a second
  run would overwrite the current-run slot.
- **`src/browsing-data.ts`** — `clearBrowsingData()`, behind Behavior → Login
  Page's "Clear cookies and local storage". The login window takes no
  partition, so it clears `session.defaultSession`: `clearData()` plus
  `clearAuthCache()`, which that does not cover. The electron-store stays — the
  point is to start the next login clean *without* resetting the SSO settings.

The one renderer is the dashboard: `src/dashboard.html`, a single self-contained
file (markup, CSS, and inline vanilla JS, no framework) that `npm run build:html`
copies verbatim into `dist/`. It is **not** type-checked or linted — `tsc` and
ESLint only see `src/*.ts` — so changes there are verified by eye and at runtime.
It talks to the main process purely over the `window.frost` bridge in
`src/preload.cts` (named operations + a `state-updated` push); the handlers live
in `src/window.ts`, which takes an `IpcCallbacks` object so it never has to
import `aws-sso.ts` (that would be a cycle). It runs sandboxed, with
`contextIsolation: true` / `nodeIntegration: false` and a CSP, so an unescaped
value is no longer code execution against a live token — but **every value
interpolated into `innerHTML` must still go through the `esc()` helper** — account names, cluster names, and error
strings all originate from AWS. For the same reason, never build a selector or
an inline `onclick` out of a value: put it in a `data-` attribute and read it
back (`esc()` is an HTML escaper, and an HTML attribute is decoded *before* its
contents are parsed as JS or CSS, so escaping does not hold there).

Register new IPC handlers with **`handleFromDashboard()`**, not `ipcMain.handle`
directly: it rejects anything that is not the dashboard's own top frame. A new
handler also needs a named method in `src/preload.cts` — the renderer has no
`ipcRenderer` of its own, so a handler without a bridge entry is unreachable
from the page, and `dashboard.html` is linted by nothing that would notice.

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
  It is unregistered from the `Session` in the window's `closed` handler, and
  that handler must use the `Session` captured while the window was alive —
  reaching for `webContents.session` (or anything else off the `WebContents`)
  once the window is gone throws `TypeError: Object has been destroyed`, which
  Electron surfaces as a modal error dialog on window close.

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
- Writes go through `writeFilePreservingMode()` (see `src/atomic-write.ts`), and
  are skipped entirely when the merged contents are unchanged. The permissions
  on this file are the user's, not ours — a plain temp-file + rename silently
  resets them, which is exactly the bug that helper exists to prevent.

If you change the generated key set in `profiles.ts`, remember adoption compares
the **full** key set — a new key means existing profiles stop matching, and they
will then be skipped as "not ours" rather than adopted.

There is no test runner in this repo. The merge logic is pure and importable, so
verify changes to it with a throwaway Node script against `dist/aws-config.js`
(stub the `electron-log/main` import) rather than trusting `tsc` alone. Include
a CRLF case: the parser preserves whichever line ending the file already uses,
which is what keeps a Windows-authored config intact.

## Cross-platform gotchas

The app is written once and packaged per platform, so the platform branches are
few and deliberate. Each one exists for a reason worth knowing before you
"simplify" it:

- **Window chrome** (`src/window.ts`). `titleBarStyle: "hiddenInset"` plus
  `trafficLightPosition` are applied **only on darwin**. On Windows
  `hiddenInset` degrades to `hidden`, which removes the title bar without
  putting the caption buttons anywhere — the dashboard ends up closable only
  with Alt+F4. `src/dashboard.html` mirrors the split: an inline script in
  `<head>` stamps `document.documentElement.dataset.platform`, and
  `html:not([data-platform="darwin"])` rules drop the 36px drag strip that
  stands in for the hidden macOS title bar.
- **Tray icons** (`src/tray.ts`). macOS and Linux use the `*.Template.png`
  files — a black shape plus alpha that macOS inverts to match the menu bar.
  Windows draws tray images verbatim, so it gets the non-template
  `TrayIcon{Full,Empty}{,@2x}.png` instead: the same snowflakes in white on the
  blue app badge, legible on a light or dark taskbar. Windows and Linux also
  wire `tray.on("click")` to the dashboard, because only macOS opens the
  context menu on a plain click.
- **Icon assets.** `src/icons/AppIcon.ico` (Windows) and the non-template tray
  PNGs are generated from the same vector data as `AppIcon.svg` by
  `tools/generate-windows-icons.py` (needs Pillow). Re-run it if the artwork
  changes; the `.icns` and `.afdesign` files remain the macOS source.
  `build:icons` globs `TrayIcon*.png`, so both sets land in `dist/`.
- **Hotkey rendering.** `src/hotkey.ts` renders an accelerator as `⌘⇧R` on
  macOS and `Ctrl+Shift+R` elsewhere; `main.ts` and `aws-sso.ts` both use it for
  notification bodies. `fmtHotkey()` in `dashboard.html` is a **hand-kept copy**
  — the renderer can't import from `dist/` — so change the two together.
- **Squirrel** (`src/squirrel.ts`). Windows installs go through
  Squirrel.Windows, which means three things the other platforms don't need:
  the install/update/uninstall command lines must be serviced and the process
  must exit (`handleSquirrelStartup()`, called first in `main()`); the app must
  claim the Application User Model ID Squirrel put on the Start Menu shortcut
  (`com.squirrel.Frost.Frost`) or Windows silently drops every notification;
  and the login item must point at `Update.exe --processStart`, because
  `Frost.exe` lives in a versioned directory that moves on every update. The
  AUMID is derived from maker-squirrel's `name`/`exe` in `forge.config.js` —
  the three have to agree.
- **Single instance.** `main()` takes `app.requestSingleInstanceLock()`. macOS
  won't launch a second copy of a bundle anyway, but on Windows and Linux a
  second launch would add a second tray icon; `second-instance` opens the
  dashboard instead.
- **Bundled authenticator** (`src/kubeconfig.ts`). The basename picks up `.exe`
  on Windows, and `findAwsIamAuthenticator()` **probes** for the file rather
  than assuming a layout — `extraResource` puts it in `resources/`, while the
  packager's wholesale copy of the project directory also leaves one in
  `resources/app/` (the only copy older builds had). The path is written into
  the user's kubeconfig, so a wrong guess only surfaces later when kubectl runs
  it.
- **`~/.aws/config` writes** (`src/aws-config.ts`). Windows fails the
  write-then-`rename` with EPERM/EBUSY while any other process has either file
  open — an AWS CLI command mid-read, or an antivirus scanner on the temp file.
  `renameWithRetry()` backs off a few times before giving up. The merge itself
  is EOL-preserving already (`parseConfig` sniffs CRLF), which is what keeps a
  Windows-authored config from being rewritten wholesale.

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

The `aws-iam-authenticator` binary is bundled into the app (`extraResource` in
`forge.config.js`) so users don't need the AWS CLI. It is **not** committed —
the build workflow downloads it at build time. The version is pinned as
`AWS_IAM_AUTHENTICATOR_VERSION` in `.github/workflows/build.yaml`. Release
asset naming is `aws-iam-authenticator_<version>_<os>_<arch>[.exe]` (os:
`darwin` | `linux` | `windows`; arch: `amd64` | `arm64`; `.exe` on Windows
only). At runtime the path is resolved in `src/kubeconfig.ts` (overridable via
`AWS_IAM_AUTHENTICATOR_PATH`).

**There is no `windows_arm64` asset** — upstream publishes none, as of 0.7.18.
The windows/arm64 matrix row therefore bundles the `windows_amd64` build, which
is why `arch.aws` is not simply a function of `arch` in `build.yaml`. That is a
deliberate and cheap trade: the authenticator is a short-lived helper process
kubectl spawns, and Windows on ARM emulates x64 processes transparently, so
only that helper pays emulation while the app itself stays native. Do not
"fix" this by dropping the arm64 row — emulating all of Chromium to keep one
occasionally-invoked CLI native is the worse side of the trade. If upstream
ever ships `windows_arm64`, the only change is `aws: amd64` → `aws: arm64` on
that row.

The packager option is `extraResource`, **singular** — the plural is
electron-builder's spelling and electron-packager ignores it silently. It was
plural here for a long while and nothing appeared broken, because the packager
also copies the whole project directory (repo root included) into
`resources/app`, so the binary arrived there by accident. Both copies now exist
in a packaged app, and `findAwsIamAuthenticator()` probes for either. Keep that
in mind before adding packager `ignore` rules: trimming `resources/app` is a
good idea, but the accidental copy is what older installs are running off.

## CI / release pipeline

Five workflows, with the matrix build factored out as a reusable workflow:

- **`.github/workflows/build.yaml`** (reusable, `workflow_call`) — the
  six-row build matrix (darwin, linux and win32 × x64/arm64) that checks out,
  installs, optionally stamps a version, builds, downloads the IAM
  authenticator, sets up the macOS signing keychain, and runs either
  `electron-forge make` (artifact upload) or `electron-forge publish` based on
  the `publish` input. Owns `AWS_IAM_AUTHENTICATOR_VERSION` and the matrix
  definition. Callers should pass `secrets: inherit` so it can read
  `MAC_CERTS`, `APPLE_API_*`, and `GITHUB_TOKEN` without re-declaring them.

  Two inputs beyond `publish`/`version` are load-bearing:

  - **`sign`** decides whether the Developer ID is imported at all. `ci.yaml`
    passes `false` for `pull_request` events, because that job has already run
    `npm ci` and `npm run build` from the pull request and a compromised
    dependency's postinstall must not be running alongside the certificate.
    Pushes to `main` still sign, so the full notarized path is validated
    before a tag. It reaches Forge as `FROST_SIGN`, which `forge.config.js`
    keys `osxSign`/`osxNotarize` off — they have to be **absent**, not empty,
    because `@electron/osx-sign` fails outright when told to sign with an
    identity that is not in the keychain.
  - **`authenticator_sha256`**, one per matrix row, pins the exact bytes of
    the downloaded authenticator. Release assets are mutable and this binary
    ends up in a signed app and in every user's kubeconfig as the `exec`
    plugin. The comment above the matrix carries the one-liner to regenerate
    the hashes when `AWS_IAM_AUTHENTICATOR_VERSION` moves; win32/arm64 shares
    the windows_amd64 asset and therefore its hash.

  The matrix is written as explicit `include` rows rather than an os × arch
  product: `exclude` does not match reliably against object-valued dimensions,
  and win32/arm64 needs a different `arch.aws` from its `arch.electron`
  (upstream publishes no windows_arm64 authenticator). Two Windows-driven
  details in the steps:
  the authenticator download runs under `shell: bash` (Git Bash) so one script
  covers all three runners, and Forge is invoked through `npx` because
  PowerShell can't execute the extensionless `./node_modules/.bin/electron-forge`
  shell script.
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
  marketing site and the documentation at the project's GitHub Pages URL — on
  pushes to `main` that touch `docs/**`. See "Documentation site" below.
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

## Documentation site

`docs/` is plain static HTML with no build step — GitHub Pages serves it as it
is committed, so anything added there has to work when opened directly.

- `docs/index.html` (landing), `docs/download.html` (reads the latest GitHub
  release at runtime) and `docs/style.css` are the marketing site.
- `docs/docs/*.html` is the documentation: one page per feature, an
  **Integrations** section (EKS and the authenticator it needs — new AWS
  services get a page there), three settings pages, and a reference section. `docs/docs.css` layers the docs shell on top
  of `style.css`; both pages of the marketing site link it too, because the
  landing page reuses `.doc-cards` and `.section-more`.
- **The page list lives in one place**: `SECTIONS` in `docs/docs/docs-nav.js`,
  which renders the sidebar (marking the current page from
  `location.pathname`) and the prev/next pager. A new page has to be added
  there or it will exist without being linked; it can be checked headlessly by
  `eval`-ing that file against a stub `document`/`location`/`window`.
- Every page carries the same shell — header, `<details class="doc-sidebar"
  id="doc-nav">`, article, `<nav id="doc-pager">`, footer. Copy an existing page
  when adding one rather than assembling it by hand.
- Content is written against the behaviour in `src/`, not against the README:
  when you change a default, a setting, a generated key set or a file path,
  the matching page in `docs/docs/` is part of that change. The pages that go
  stale fastest are `settings*.html`, `files.html` and `profiles.html`.
- Worth re-running after edits: a link/anchor check across `docs/**/*.html`
  (every `href` that is not external should resolve to a file, and every
  fragment to an `id`), and a Playwright pass in both colour schemes at a
  narrow and a wide viewport — `docs.css` is not otherwise exercised by
  anything.

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

## Windows packaging (Squirrel)

`@electron-forge/maker-squirrel` builds the Windows installer; macOS and Linux
still use `maker-zip`. Things worth knowing:

- The maker's `config` is a **function of the target arch**, which is a
  supported Forge API (`MakerBase` calls it `configOrConfigFetcher`). That is
  how `setupExe` gets the real architecture in its name
  (`Frost-win32-<arch>-<version>.exe`) instead of the runner's. The version is
  read out of `package.json` at config-load time, which is correct because the
  release pipeline stamps it there first.
- `noMsi: true`. Squirrel would otherwise also emit an `.msi` that doesn't
  auto-update; the `.exe` is the only artifact we ship.
- `iconUrl` must be an **absolute HTTP URL** (Add/Remove Programs fetches it),
  so it points at the raw `AppIcon.ico` on `main` — unlike `setupIcon`, which
  is a local path.
- `electron-packager` picks the icon extension per platform, so
  `packagerConfig.icon: "./src/icons/AppIcon"` resolves to `AppIcon.ico` here.
  That file has to exist in the source tree at package time, which is why it's
  committed.
- Squirrel emits `RELEASES` and a `.nupkg` alongside the installer. Those are
  what `update-electron-app`/update.electronjs.org reads on Windows — don't
  prune them from a release, and don't let the downloads page offer them
  (`docs/download.html` filters them out by design).
- **Two Windows architectures share one GitHub release, and Squirrel names its
  output the same way every time.** Left alone, x64 and arm64 would both
  upload `RELEASES` and `<id>-<version>-full.nupkg`, one would clobber the
  other, and the survivor would feed its payload to *both* architectures on the
  next auto-update. Two things keep them apart:
  - `squirrelPackageName(arch)` puts the architecture in the **package id**
    (`Frost-arm64`), so the nupkg is `Frost-arm64-<version>-full.nupkg`. It has
    to be the id, not a suffix after the version: Squirrel parses
    `<id>-<version>-full.nupkg` with the version in a fixed position, so
    `Frost-<version>-arm64-full.nupkg` would not parse. x64 keeps the bare
    `Frost`, and once it has shipped that id is fixed — changing it would
    strand installed clients on a feed whose package no longer matches.
  - The `postMake` hook renames arm64's `RELEASES` to `RELEASES-arm64`, which
    is what update.electronjs.org looks for before falling back to plain
    `RELEASES`. That fallback is why x64 needs no per-arch file and its asset
    names are byte-identical to a single-architecture build.

  Because the id feeds the AUMID, `src/squirrel.ts` derives its own from
  `process.arch` using the same rule. A build is only ever installed by the
  package of its own architecture, so the two always agree.
- Windows builds are **unsigned**: there's no certificate, and SmartScreen
  warns on first run. `forge.config.js` reads `WINDOWS_CERTIFICATE_FILE` /
  `WINDOWS_CERTIFICATE_PASSWORD` from the environment and feeds them to
  `windowsSign` when set, so wiring up signing later is a workflow change only
  — the config is inert while they're unset. Use `windowsSign`
  (`@electron/windows-sign`), not the top-level
  `certificateFile`/`certificatePassword` pair: electron-winstaller still
  accepts those but documents them as legacy, and only `windowsSign` extends to
  EV certificates and cloud signing.

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

Windows packaging can't be exercised here either: `maker-squirrel` needs a
Windows host, and even plain `electron-forge package --platform win32` shells
out to `rcedit` to stamp the icon, which needs Wine off Windows.

That matters most for the multi-architecture asset naming above, where a
mistake corrupts auto-update for people who already installed. What *is*
checkable without Windows: reproduce the artifact list from `MakerSquirrel`'s
own logic (`prepareConfig(arch)` plus the three names its `make()` returns),
run `forge.config.js`'s `postMake` hook over real temp files, flatten both
architectures into one list, and assert the names are disjoint. That catches
every collision; it does not tell you whether Squirrel installs an arm64
payload correctly, which needs real hardware.

**Squirrel's own binaries are all x86** — `Setup.exe`, `Squirrel.exe`,
`StubExecutable.exe`, `SyncReleases.exe` in `electron-winstaller/vendor` are
i386 (only the bundled 7-Zip has an arm64 variant). They run under emulation on
Windows on ARM and then launch the native app. Squirrel.Windows historically had
an arm64 bug (Squirrel.Windows#1616, fixed by #1617 for v2); whether the
vendored build carries the fix has not been confirmed on hardware, so treat
arm64 installs as needing a real-device smoke test before you trust them.

A few things that *are* checkable headlessly and worth doing, since nothing
else covers them:

- **`dashboard.html`** is neither type-checked nor linted. Its `<script>`
  blocks can be pulled out and run in `node:vm` against a stub `document` /
  `require("electron")`, once per `process.platform`, which catches load-time
  breakage (a temporal dead zone, a typo) that would otherwise only show up as
  a blank window. Stub the timers — the script installs a 30s interval that
  keeps Node alive.

  Better, where a change is about *behaviour* rather than load: load the built
  `dist/dashboard.html` in headless Chromium (Playwright, with Chromium already
  on most sandboxes) after injecting a `<script>` that defines `window.require`
  to return a fake `ipcRenderer` and `window.process = { platform }`. That
  exercises real rendering, clicks and state pushes. Seed the fake state with
  hostile values — `<img src=x onerror=…>` in an account or cluster name, a
  quote in an id — and assert nothing executes; it is the only mechanical check
  on the `esc()` rule above. One caveat: the `<head>` script at the top of the
  file reads `process.platform` before any injected stub can load, so expect one
  harmless `ReferenceError` in the page-error log.
- **The preload bridge**: assert every `frost.<name>` in `dashboard.html` has an
  entry in `src/preload.cts`. Nothing type-checks the two against each other, so
  a missing one is a button that does nothing (#76).
- **`forge.config.js`** can be imported directly, and the maker instantiated
  the same way Forge does (`new MakerSquirrel(cfg, platforms)` then
  `await maker.prepareConfig(arch)`), to confirm the per-arch config resolves
  and that the AUMID in `src/squirrel.ts` still matches `name`/`exe`.
- **`docs/download.html`**'s release-parsing script runs the same way against a
  synthetic GitHub release payload, which is how you check asset-name changes
  without cutting a release.
- **File-permission behaviour** (`src/atomic-write.ts`) is checkable directly:
  import the built module and run it over a scratch directory. Cover an
  existing 0600 and an existing 0640 (a preserved mode must not be narrowed by
  the umask), a file that does not exist yet, and — the case a hand-rolled
  implementation gets wrong — a path that is a **symlink** into another
  directory, asserting the link survives and the target is what changed.

Windows-specific behaviour — Squirrel install/update events, the tray icon and
click handling, toast notifications, the login item — cannot be exercised
anywhere but a real Windows machine. The CI matrix proves the installer
*builds*; it does not prove it installs.
