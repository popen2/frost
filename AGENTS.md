# AGENTS.md

Gotchas for working on Frost. Read before changing build config, dependencies,
or the release pipeline.

## Layout

Frost is an Electron tray app (an AWS SSO credentials refresher) for macOS,
Windows and Linux. There is no bundler; almost every `src/*.ts` runs in the
main process. Three exceptions:

- `src/login-overlay.ts` is browser code injected into the login page (the
  WebAuthn toast). It has its own compile (`tsconfig.overlay.json`); the main
  `tsconfig.json` excludes it.
- `src/approve-overlay.ts` is the same kind of thing under the same compile —
  the driver that clicks the AWS approval steps. Neither may import anything:
  an import makes the output a module, which is not injectable as a classic
  script, and is why each signal constant is duplicated in its main-process
  counterpart rather than shared.
- `src/dashboard.html` is copied verbatim by `build:html` and is neither
  type-checked nor linted.

Any other copied asset needs its own `copyfiles` step in the `build` script; a
missing one fails at runtime only.

## Prefer these modules over doing it inline

- **`src/atomic-write.ts`** — `writeFilePreservingMode()` for files the user
  co-owns (`~/.aws/config`, `~/.kube/config`). A hand-rolled temp-file +
  rename replaces the inode, dropping the destination's mode, owner and
  symlink identity. Files that must be 0600 whatever they replace (the SSO
  token cache) call `atomically` directly.
- **`src/logging.ts`** — transport config, retention sweep, `describeError()`.
  Log errors through it; interpolating the error loses the AWS SDK's exception
  name, HTTP status and request id.
- **`src/user-config.ts`** — `validateUserConfig()`. Kept out of `config.ts`,
  which constructs the electron-store and so needs a live Electron app.
- **`src/run-log.ts`** — the per-run step log behind the Activity panel. One
  run at a time; `refresh()` guards on `isWorking` because a second run would
  overwrite the current-run slot.
- **`src/schedule.ts`** — every delay `setNextTokenRefresh()` may use. Three
  rules: a retry delay is never derived from the stored token expiry (after a
  failure it is in the past, which collapses to the floor and reopens the login
  page in a loop); a login nobody completed is not retried on a timer; a
  failure *after* the token was renewed keeps the expiry schedule rather than
  an error retry, which would reopen the login page for an unrelated failure.
  No electron imports.
- **`src/page-script.ts`** — `loadPageScript()` / `injectIntoEveryFrame()`,
  used by both injected scripts. Injection follows sub-frames because
  `executeJavaScript` on a `WebContents` reaches the top frame only, and a
  sign-in page routinely puts the interesting part in a cross-origin `<iframe>`.
- **`src/auto-approve.ts`** — the main-process half of automatic approval (see
  its own section). Its timers are what guarantee a hidden login window always
  ends up in front of the user.
- **`src/browsing-data.ts`** — `clearBrowsingData()`. The login window takes no
  partition, so it clears `session.defaultSession`: `clearData()` plus
  `clearAuthCache()`, which that does not cover. Settings are left alone.

## Dashboard

`src/dashboard.html` is the only renderer: one self-contained file, no
framework, not type-checked or linted.

- It reaches the main process only through the `window.frost` bridge in
  `src/preload.cts`. Handlers live in `src/window.ts`, which takes an
  `IpcCallbacks` object so it never imports `aws-sso.ts` — that would be a
  cycle.
- Every value interpolated into `innerHTML` must go through `esc()`; account
  names, cluster names and error strings come from AWS. Never build a selector
  or an inline handler out of a value — an HTML attribute is decoded before its
  contents are parsed as JS or CSS, so escaping does not hold there. Put it in
  a `data-` attribute and read it back.
- New IPC handlers go through `handleFromDashboard()`, which rejects anything
  but the dashboard's own top frame, and need a matching entry in
  `src/preload.cts`. Nothing type-checks the two against each other, so a
  missing entry is a button that silently does nothing.

## Commands

npm only (`package-lock.json`; CI runs `npm ci`). Do not add a `yarn.lock`.

- `npm run build` — `tsc`, then copies the tray icons and `dashboard.html`.
- `npm run lint` — oxlint, configured by `.oxlintrc.json`.
- `npm run check:overlay` — drives the login window's credential overlay
  through a real WebAuthn wait. Needs `npm run build` first, and a display:
  `xvfb-run -a npm run check:overlay -- --no-sandbox`.
- `npm run check:auto-approve` — drives a whole `refresh()` against a stubbed
  AWS SSO, end to end. Same requirements, same shape:
  `xvfb-run -a npm run check:auto-approve -- --no-sandbox`.
- `npm start` / `npm run package` / `npm run make` — Electron Forge.

All of those run in CI. The two `check:` scripts run as their own job
(**🧪 End-to-end checks**) rather than inside the lint job: they boot the real
app and are the likeliest reason a pull request is red, so they report under a
name that says so. Build and lint alone do not prove the app launches; see
"Verification limits".

## ESM

`"type": "module"`, `module`/`moduleResolution: NodeNext`.

- Relative imports carry a `.js` extension even though the source is `.ts`.
- No `__dirname`/`__filename`; derive it from `import.meta.url`.
- `tsconfig` needs an explicit `rootDir`.
- `forge.config.js` is ESM; no `require`.

## Login window WebAuthn overlay

Electron services `navigator.credentials` but draws no UI, so a page waiting
for a security key looks broken. `src/login-indicator.ts` fills that gap, wired
up before `loadURL` and only for the in-app window; the default-browser mode
gets the browser's own prompts.

- `src/login-overlay.ts` is compiled separately, read off disk, and injected
  into every document the login window loads. It wraps
  `navigator.credentials.{get,create}` and draws a toast while a request is
  pending. It re-injects safely; a `window` flag makes it a no-op.
- **It has to be running before the page's own scripts are.** A page that asks
  for the key as it boots — Google's security-key challenge does — has already
  called `navigator.credentials.get()` by `dom-ready`, and a wrapper installed
  after the call sees nothing: no toast, no title, no log line, just the silent
  window the overlay exists to prevent. So `attachLoginIndicator()` registers
  it through the `WebContents` debugger with
  `Page.addScriptToEvaluateOnNewDocument`, which runs it at document start in
  the page's own world. Three details there all fail silently:
    - `Page.enable` first, or the registration resolves and does nothing.
    - There has to be a renderer to talk to. On a window that has loaded
      nothing the command never resolves — no error, a hung promise — which is
      why `attachLoginIndicator()` loads `about:blank` first, is `async`, and
      must be awaited before `loadURL`.
    - It reaches the top document — across the cross-origin hop to the identity
      provider, which changes renderer process — and frames sharing its
      process, but not a cross-origin `<iframe>`, which has its own CDP target.
  Injecting on `dom-ready`, main frame plus sub-frames
  (`src/page-script.ts`), stays as the fallback for those and for a debugger
  that would not attach. Being attached is also why the login window cannot
  open DevTools.
- Its compile differs deliberately: `module: ESNext` (NodeNext would append an
  export statement, a syntax error in an injected classic script), `lib: DOM`
  with no Node types, and no source map. It must stay import-free — an import
  makes the output a module and breaks injection, which is why its signal
  constant is duplicated rather than shared with the indicator. Keep the two
  in sync.
- The overlay runs in the page's world, so its only channel back is a
  console line with a magic prefix. The remote page could forge those, so
  nothing security-relevant may depend on them.
- It lands on pages Frost does not control: no `innerHTML`, no `<style>`
  elements (CSP and Trusted Types reject them), a closed shadow root, host
  styles pinned `!important`, and `pointer-events: none` so it cannot swallow a
  click.
- `select-webauthn-account` is registered on the session here. Electron cancels
  the request outright when nothing is listening, which blocks any key holding
  several credentials for the same relying party. Invoke the callback exactly
  once on every path, and unregister using the `Session` captured while the
  window was alive — reaching through the destroyed `WebContents` throws, which
  Electron shows as a modal dialog on close.

`attachLoginIndicator()` takes an optional `onUserNeeded` callback and calls it
when a credential request starts and before the account picker opens. Under
automatic approval the window may not be on screen yet, and a modal sheet on a
window nobody can see is a prompt nobody can answer.

`npm run check:overlay` is the regression test for all of that: it drives the
real `attachLoginIndicator()` on a real `BrowserWindow` against pages that ask
for a key before and after `dom-ready`, and asserts the wait reached the main
process. No key needed — only the start of the request matters, and that is
signalled the moment the page asks. CI runs it.

The overlay's drawing can also be checked on its own, since it is import-free
browser code: `new Function("window", source)` over the built
`dist/login-overlay.js` with a stub `window`, or a Playwright page — the only
way to try it against a strict CSP or hostile `!important` CSS.

## Automatic approval

AWS SSO's device authorization is a multi-step approval — confirm the request,
sign in, grant access — and none of the approval steps carry anything the user
has to supply. `src/approve-overlay.ts` clicks them, `src/auto-approve.ts`
watches, and `getNewToken()` keeps the window hidden (`show: false`) until one
of them says the user is needed (issue #1). Keep these true:

- **The login always ends up somewhere.** `auto-approve.ts` runs a stall timer
  (reset by navigations, loads and clicks) and an absolute one, and hands over
  on a failed load or an unreadable script. Every exit from the silent attempt
  reaches `onUserNeeded`, which becomes `window.show()` — or, in
  default-browser mode, `shell.openExternal`, destroying the hidden probe only
  once the browser is up. A new way for the flow to end without arriving there
  is a refresh that hangs invisibly until the device code expires.
- **`backgroundThrottling: false` on the window.** Chromium throttles timers in
  a window that is not visible, and the driver's scan loop is a timer.
- **Clicking is deliberately narrow.** Only on the device-authorization hosts
  (`*.awsapps.com`, `device.sso.<region>.amazonaws.com`), only controls matched
  by AWS's own ids or an *exact* label, never one whose label reads like a
  refusal, and a few per document at most. Anything else stalls, and stalling
  shows the window — the safe failure. The buttons next to the ones we want
  deny the request.
- **"The user is needed" is an empty visible field.** The device page's own
  code field arrives prefilled from `verificationUriComplete`; an empty one is
  a password, a username or a one-time code. Scanning continues after the user
  takes over, so the approval steps after their sign-in are still clicked.
- **The hand-over goes to the surface the settings ask for**, which includes
  notify mode: with automatic approval on, the notification moves from the
  start of every refresh to the hand-over, and nothing opens until the user
  answers it (`triggerPendingAuth()`, the same trigger the hotkey uses). The
  wait is cancelled when the run ends, or `hasPendingAuth()` would keep saying
  yes and swallow the next hotkey press.
- The console signal is forgeable by the page, exactly like the overlay's, so
  it may only ever decide whether to show a window.

`npm run check:auto-approve` (`tools/check-auto-approve.js`) is the regression
test, and it is end to end: it drives the real `refresh()` — the entry point
the tray, the hotkey and the timer all use — against a stub of AWS SSO, and
asserts on what the user would have seen. Three interceptions make that
possible without the app knowing it is under test, and all three are worth
keeping:

- `AWS_ENDPOINT_URL_SSO_OIDC` / `AWS_ENDPOINT_URL_SSO` are an AWS SDK feature,
  so the device authorization, the polling and its
  AuthorizationPendingException are the real client talking a real protocol to
  a stub service over HTTP. The token only becomes redeemable when the stub's
  approval page is actually fetched, so nothing passes without a real click.
- `session.protocol.handle("https", ...)` serves the pages at their real names,
  so the renderer sees `https://d-….awsapps.com`, a secure context, and a
  genuine cross-origin redirect to the identity provider. Served from localhost
  it would prove nothing: the host rule is the point.
- `Notification.prototype.show` and `shell.openExternal` are recorded rather
  than performed — "what was the user told" and "where were they sent" are the
  assertions, and a CI container has neither a notification daemon nor a
  browser. `Notification` itself is a non-configurable export, so the patch has
  to go on the prototype.

`HOME` and the electron-store move to a temp directory, so a run touches
nothing of yours. Eight scenarios, ~27s, one per outcome:

| Scenario | What must be true |
| --- | --- |
| Portal session is live | Token collected, **no window ever shown**, no notification |
| Federated, IdP session is live | Same, and the cross-origin hop happened |
| Federated, IdP wants a password | Window shown; after the check signs in, the driver finishes the approval |
| The same in notify mode | **Notification first, nothing shown** until `triggerPendingAuth()`; then the window |
| The same in default-browser mode | `openExternal` gets the verification URL, no window shown |
| Automatic approval off | Window visible from the start, nothing driven |
| IdP page with an "Allow access" button | Never clicked — it is not our host |
| AWS page nothing recognises | Nothing clicked, including a refusal wearing `cli_login_button`'s id; window comes up |

It is a real test, not a smoke test, and each mutation fails exactly one
scenario: the host rule returning `false` fails both approval scenarios and
returning `true` fails the identity-provider one; dropping the refusal rule
fails the unrecognised-page one; skipping the notify branch of the hand-over
fails the notify one. Confirm with a mutation before trusting a change here.

The matching rules alone can also be exercised without a browser —
`approve-overlay.ts` is import-free, so `new Function("window", source)` over
the built file with a stub `window` runs them — which is the quicker loop while
writing them.

## `~/.aws/config` ownership

`src/aws-config.ts` merges into the user's file and must never rewrite it
wholesale; it is shared with the AWS CLI and with whatever the user wrote by
hand. `mergeAwsConfig()` is pure.

- Frost's own profiles carry a marker comment under the section header. Only
  marked sections are rewritten or removed.
- Unmarked sections survive verbatim — comments, blank lines, `sso-session` and
  `services` sections. Comments above a header travel with that section.
- An unmarked profile whose keys and values exactly match what Frost would
  generate is adopted and marked. That is the upgrade path from versions that
  wrote no marker; without it the first refresh would duplicate every profile.
  Adoption compares the **full** key set, so adding a generated key means
  existing profiles stop matching and get skipped instead.
- A same-named profile the user wrote is left alone and Frost skips its own.
- Writes go through `writeFilePreservingMode()` and are skipped when the merged
  contents are unchanged.

## `~/.kube/config` ownership

`src/kubeconfig.ts` merges into the user's file for the same reason
`aws-config.ts` does: most of it is theirs. `mergeKubeconfig()` is pure.

- The parsed YAML document is **edited in place**, never rebuilt from a model of
  a kubeconfig. Everything Frost does not write — `current-context`,
  `preferences`, per-entry `extensions`, impersonation keys, `token-file` — is
  in the document it was loaded from and goes back out untouched.
- That is what `@kubernetes/client-node` got wrong, and why it is gone. Its
  model carried only the fields it knew, so a round trip dropped the rest, and
  its loader **throws** on an entry it dislikes — a context with no cluster,
  which is what `kubectl config set-context x --namespace=y` writes. The throw
  was caught at `debug` and the half-loaded config overwrote the file, taking
  every user, every context and `current-context` with it.
- One cluster, one user and one context per discovered cluster, named by
  `getNamePattern()`. A same-named entry is updated **in place and by merge**,
  so a namespace the user set on one of Frost's contexts survives a refresh.
- A file that does not parse is **left alone**, logged at `error`. Skipping an
  update beats replacing a file we could not read.
- Unchanged contents skip the write. `yaml.dump` runs with `lineWidth: -1`: the
  default 80 folds certificate data and the authenticator path across lines,
  which is legal but unlike what `aws eks update-kubeconfig` writes.
- Writes go through `writeFilePreservingMode()`.

`getNamePattern()` picks the shortest context name that still tells the
discovered clusters apart (`docs/docs/eks.html` has the table users see). Its
`uniqueClusters` test compares distinct cluster **names** against distinct
cluster **ids** (`name:account:region`) — one cluster reached through several
profiles is one of each; two clusters sharing a name are two ids and one name.
Comparing the two lists' lengths, as it did originally, is always true, and two
clusters sharing a name then collapse onto one context with one of them lost.

## Cross-platform

Each platform branch exists for a reason.

- **Window chrome** (`src/window.ts`): the macOS hidden title bar and traffic
  light position are darwin-only. On Windows the same setting removes the title
  bar without placing caption buttons anywhere, leaving the dashboard closable
  only by keyboard. `dashboard.html` mirrors the split off a platform attribute
  stamped on `documentElement`.
- **Tray icons** (`src/tray.ts`): macOS and Linux use the template PNGs, which
  macOS inverts to match the menu bar. Windows draws images verbatim, so it
  gets the non-template set. Windows and Linux also wire a tray click to the
  dashboard; only macOS opens the context menu on a plain click.
- **Icon assets**: the Windows `.ico` and non-template tray PNGs are generated
  by `tools/generate-windows-icons.py` (needs Pillow) from the same vector data
  as the SVG. The `.icns` and `.afdesign` files stay the macOS source.
- **Hotkeys** (`src/hotkey.ts`): symbols on macOS, `Ctrl+Shift+…` elsewhere.
  `dashboard.html` keeps a hand-copied version because the renderer cannot
  import from `dist/`; change both together.
- **Squirrel** (`src/squirrel.ts`): Windows installs need the
  install/update/uninstall command lines serviced with an immediate exit
  (first thing in `main()`); the app must claim the Application User Model ID
  from the Start Menu shortcut or Windows drops every notification; and the
  login item must point at Squirrel's updater, because the executable lives in
  a versioned directory that moves on each update. The AUMID is derived from
  maker-squirrel's `name`/`exe` — the two must agree.
- **Single instance**: `main()` takes the single-instance lock. On Windows and
  Linux a second launch would add a second tray icon; it opens the dashboard
  instead.
- **Bundled authenticator** (`src/kubeconfig.ts`): the basename gains `.exe` on
  Windows, and the lookup probes for the file rather than assuming a layout —
  it exists both where `extraResource` puts it and in the packager's wholesale
  copy of the project directory. The resolved path is written into the user's
  kubeconfig, so a wrong guess surfaces only when kubectl runs it.
- **`~/.aws/config` writes**: Windows fails the rename with EPERM/EBUSY while
  another process holds either file open, so the write retries with backoff.
  The parser preserves whichever line ending the file already uses.

## Dependencies

- **AWS SDK v3** modular clients with the command pattern. SSO role credentials
  come from `fromSSO`, reading the profiles and token cache the app writes.
  Service errors are exported classes, so match them with `instanceof`. Do not
  reintroduce SDK v2.
- **electron-log v5**: import `electron-log/main` in the main process; error
  catching moved to `log.errorHandler`.
- **update-electron-app v3**: named export.
- **electron-store v11**, **delay v7**, **uuid v14**: pure ESM.
- **@kubernetes/client-node is gone, and should not come back.** It was a lossy
  YAML shuttle for a file the app never talks to a cluster about — see
  "`~/.kube/config` ownership". Dropping it also dropped `@types/ws`, a
  devDependency only because the client's types reach `ws` through
  `isomorphic-ws`.
- **oxlint, not ESLint.** oxlint has its own parser and never loads the
  TypeScript compiler API, which is what lets this repo hold a single
  TypeScript — see the TypeScript note below. `eslint`, `typescript-eslint` and
  `@eslint/js` are gone; don't reintroduce them without reading that note.
  `.oxlintrc.json` **pins the rule set**: `categories.correctness` is off and
  `plugins` is just `["typescript"]`, so the 68 listed rules are all that run —
  a faithful port of what `js.configs.recommended` plus
  `tseslint.configs.recommended` enforced, and immune to a new oxlint release
  widening it. Enabling a category is a real decision; make it deliberately,
  with the new findings fixed. Only `no-octal` had no equivalent, and it is
  unreachable: octal literals are a syntax error in an ES module, so `tsc`
  rejects them first. `no-unassigned-vars` still catches pagination loops that
  never reassign their continuation token. Type-aware rules are available but
  off — `oxlint --type-aware` with `oxlint-tsgolint`, which runs on TS 7 — and
  currently report a dozen findings worth fixing on their own terms.
- **js-yaml v5** ships its own types; `@types/js-yaml` was dropped. `@types/ini`
  is still needed.
- **TypeScript 7, and only one of it.** TS 7's package exports `version` and
  `versionMajorMinor` from its main entry and nothing else — the TS 6 compiler
  API moved behind `typescript/unstable/*` in a different shape. So **any** tool
  doing `import ts from "typescript"` needs a TypeScript 6 alongside TS 7; that
  is not an eslint quirk, and ts-jest, ts-node and ts-morph are in the same
  position. The linter was the only such tool here, which is why it is oxlint.
  Before adding a dependency that reaches for the compiler API, grep
  `node_modules` for `require("typescript")` — if the answer stops being "none",
  the single-TypeScript property is what you are trading away.
- **Electron 44 requires macOS 13.** Chromium dropped Monterey. Nothing in
  `src/` used the APIs 44 removed (renderer `clipboard`, `app.isUnityRunning`,
  `setProgressBar`/`setBadgeCount`, `net.request`, the
  `select-client-certificate` signature) and the build matrix was already
  64-bit only, so the OS floor is the whole of the breaking change. `README.md`
  and `docs/docs/platforms.html` say so, because the in-place updater does not
  check the OS version before installing.

- **No `overrides` block.** The former entries are resolved by upgrading
  parents. Prefer that over adding an override, and re-check `npm audit` with
  the block empty first.
- `axios` was unused and was dropped. The app makes no direct HTTP calls.

## AWS IAM authenticator

Bundled via `extraResource` so users need no AWS CLI, and **not** committed —
the build downloads it, pinned by version and per-row SHA-256 in
`build.yaml`. The runtime path is resolved in `src/kubeconfig.ts` and can be
overridden with `AWS_IAM_AUTHENTICATOR_PATH`.

Upstream publishes no `windows_arm64` asset, so that matrix row bundles the
amd64 build; this is why the AWS arch is not a function of the Electron arch.
Windows on ARM emulates that short-lived helper transparently while the app
stays native. Do not drop the arm64 row to "fix" it.

The packager option is `extraResource`, **singular** — the plural is
electron-builder's spelling and is ignored silently. Both copies of the binary
exist in a packaged app (the packager also copies the project directory into
resources), and older installs run off the accidental one, so be careful
adding packager `ignore` rules.

## CI / release

- **`build.yaml`** (reusable) — the six-row matrix (darwin, linux, win32 ×
  x64/arm64): install, optionally stamp the version, build, download the
  authenticator, set up the macOS keychain, `electron-forge make`. Its
  `publish` input decides whether `out/make` goes to the GitHub release or to
  workflow artifacts. Callers pass `secrets: inherit`. Steps longer than a
  one-liner live in `.github/scripts/` and take inputs from `env:`.
  - **There is no Forge publisher, and `electron-forge publish` must not come
    back** — it fails outright here. Assets go up with the GitHub CLI.
  - `sign` decides whether the Developer ID is imported at all. Pull requests
    pass `false`, because that job has already run `npm ci` and `npm run build`
    from the PR and a compromised postinstall must not run alongside the
    certificate. It reaches Forge as an env var that the signing and
    notarization options key off; they must be **absent**, not empty, or
    signing fails against an identity that is not in the keychain.
  - `authenticator_sha256` pins the exact bytes per row. Release assets are
    mutable, and this binary ends up signed and in every user's kubeconfig.
  - The matrix is explicit `include` rows: `exclude` does not match reliably
    against object-valued dimensions. The authenticator download runs under
    Git Bash so one script covers all runners, and Forge is invoked through
    `npx` because PowerShell cannot execute the extensionless shim.
- **`ci.yaml`** — pull requests to `main` and pushes to `main`. Lints, then
  calls `build.yaml` with `publish: false`; signs and notarizes macOS and
  uploads the zips as artifacts. Never tags or publishes. Notarization secrets
  are unavailable to forks. Pushes to `main` also refresh the release-drafter
  draft.
- **`release.yaml`** — `workflow_dispatch` only, and it is the whole release:
  read the tag off the draft, build the matrix, attach, publish, pinned to the
  commit that was built. Releases are attributed to the actions bot.
  **Never publish the draft from the GitHub UI, and never add a `push: tags` or
  `release: published` trigger.** Immutable releases are on: publishing seals a
  release, a sealed one cannot be repaired, and a botched one costs the version
  number.
- **`pages.yaml`** — publishes `docs/` on pushes to `main` touching `docs/**`.
- **`autolabeler.yaml`** — applies changelog labels from branch-name patterns
  (`feat/`, `fix/`, `chore/`). Any other prefix needs labels set by hand.

**Version numbers come from PR labels, not `package.json`.** The
release-drafter resolver reads `major`/`minor`/`patch` off merged PRs and
defaults to patch. The draft's tag is the version being released, so the
`v`-prefixed tag template has to stay. CI overwrites the version in
`package.json` from the tag — do not bump it manually.

`NODEJS_VERSION` is declared in both `ci.yaml` and `build.yaml`; keep them in
sync. It must satisfy Node >= 22.12, the floor declared by the packager and the
macOS signer.

## Documentation site

`docs/` is static HTML with no build step, served as committed, so anything
added has to work opened directly.

- `docs/index.html`, `docs/download.html` (reads the latest release at runtime)
  and `docs/style.css` are the marketing site.
- `docs/docs/*.html` is the documentation, one page per feature, plus settings
  and reference pages. `docs/docs.css` layers on `style.css`, which the
  marketing pages also link because the landing page reuses its card styles.
- **The page list lives only in `SECTIONS` in `docs/docs/docs-nav.js`**, which
  renders the sidebar and the pager. A page missing from it exists but is
  unlinked.
- Every page carries the same shell. Copy an existing page rather than
  assembling one.
- Content is written against the behaviour in `src/`, not the README: changing
  a default, a setting, a generated key set or a file path means updating the
  matching page. `settings*.html`, `files.html` and `profiles.html` go stale
  fastest.
- Worth re-running after edits: a link and anchor check across `docs/**/*.html`,
  and a Playwright pass in both colour schemes at a narrow and a wide viewport,
  since nothing else exercises `docs.css`.

## Electron Forge 8 (prerelease, deliberate)

The `@electron-forge/*` devDeps are pinned to an exact alpha — no `^`, which
would drift across alphas silently. Downgrading to the 7.x stable line
reintroduces an unfixable symlink path-traversal advisory
(GHSA-jmr9-qjv8-65gv) through the packager's zip extraction; the packager major
that Forge 8 adapted to replaced that dependency. Pulling the newer packager
under Forge 7 via an override does not work — its hooks became promise-based
while Forge 7 still passes a callback. Move to `^8.x` when it goes stable.

## Windows packaging (Squirrel)

`maker-squirrel` builds the Windows installer; macOS and Linux use `maker-zip`.

- The maker's config is a **function of the target arch**, a supported Forge
  API, which is how the installer name gets the real architecture instead of
  the runner's. It reads the version from `package.json` at config-load time,
  after the pipeline has stamped it.
- `noMsi: true` — the `.msi` would not auto-update and is not shipped.
- `iconUrl` must be an absolute HTTP URL (Add/Remove Programs fetches it),
  unlike `setupIcon`, which is a local path. The `.ico` must exist in the
  source tree at package time, which is why it is committed.
- Squirrel also emits `RELEASES` and a `.nupkg`; the Windows auto-updater reads
  them. Do not prune them from a release, and keep the downloads page filtering
  them out.
- **Two Windows architectures share one release, and Squirrel names its output
  identically each time.** Left alone they clobber each other and the survivor
  feeds its payload to both architectures on the next update. Two things
  prevent that:
  - the architecture goes in the **package id**, so the nupkg name differs. It
    has to be the id, not a suffix after the version, because Squirrel parses
    the version from a fixed position. x64 keeps the bare id, and once shipped
    that id is fixed — changing it strands installed clients.
  - a `postMake` hook renames arm64's `RELEASES` to the per-arch name the
    updater looks for before falling back to the plain one. That fallback is
    why x64 needs no per-arch file.

  Because the id feeds the AUMID, `src/squirrel.ts` derives its own the same
  way from `process.arch`; a build is only ever installed by its own
  architecture's package.
- Windows builds are **unsigned** and SmartScreen warns on first run.
  `forge.config.js` reads certificate path and password from the environment
  and feeds `windowsSign` when set, so enabling signing is a workflow change
  only. Use `windowsSign`, not the legacy top-level pair, which does not extend
  to EV or cloud signing.

## macOS signing/notarization

Requires Apple certs and secrets, and runs only on a CI macOS runner — it
cannot be validated locally.

- Signing uses per-file options for entitlements, hardened runtime and
  signature flags. The old kebab-case keys are silently ignored.
- Notarization uses notarytool API-key auth: the key option is the **path** to
  the `.p8`, plus key id and issuer. The workflow writes the key to the
  location the tool expects.

## Verification limits

Headless, you can run build, lint, isolated Node checks of individual modules,
and — with network access to the Electron downloads — `package`/`make` **for
linux**.

You *can* also launch it, given those same downloads and `xvfb`:
`xvfb-run -a ./node_modules/electron/dist/electron --no-sandbox .` boots the
whole app, and `npm run check:overlay` and `npm run check:auto-approve` use
that to drive a real `BrowserWindow` — the latter running a whole `refresh()`
against a stubbed AWS SSO, so the login path can be exercised end to end
without an AWS account. That is how the overlay's document-start bug was found;
build and lint could not have. What it does **not** give you is a real desktop: no
tray interaction, no dock, no security key, no keychain, no macOS signing. Say
so rather than claiming the app works.

Windows packaging cannot be exercised either: the maker needs a Windows host,
and even plain packaging shells out to `rcedit`, which needs Wine off Windows.
That matters most for the multi-architecture asset naming, where a mistake
corrupts auto-update for existing installs. What is checkable: reproduce the
artifact list from the maker's own logic, run the `postMake` hook over temp
files, flatten both architectures into one list, and assert the names are
disjoint. That catches every collision but says nothing about whether an arm64
install works — Squirrel's own vendored binaries are x86 and run under
emulation, and it historically had an arm64 bug whose fix is unconfirmed here,
so treat arm64 installs as needing a real-device smoke test.

Worth doing headlessly, since nothing else covers it:

- **`dashboard.html`**: pull its scripts into `node:vm` against a stub
  `document` and `electron`, once per platform, to catch load-time breakage
  that would otherwise show as a blank window. Stub the timers; the script
  installs a long-lived interval. For behaviour rather than load, load the
  built file in headless Chromium with a fake IPC bridge injected — that
  exercises real rendering and state pushes, and seeding hostile values into
  account and cluster names is the only mechanical check on the `esc()` rule.
  The head script reads the platform before any stub can load, so expect one
  harmless error in the page log.
- **The preload bridge**: assert every `frost.<name>` used in the dashboard has
  an entry in `src/preload.cts`.
- **`forge.config.js`** can be imported and the maker instantiated the way
  Forge does, to confirm the per-arch config resolves and the AUMID still
  matches.
- **`docs/download.html`**'s release parsing runs against a synthetic release
  payload, which checks asset-name changes without cutting a release.
- **`src/atomic-write.ts`**: run the built module over a scratch directory.
  Cover an existing 0600 and 0640 (a preserved mode must not be narrowed by the
  umask), a file that does not exist, and a path that is a **symlink** into
  another directory — assert the link survives and the target changed.
- **`src/aws-config.ts`**: the merge is pure and importable, so exercise it
  with a throwaway script (stub the logging import). Include a CRLF case.
- **`src/kubeconfig.ts`**: `mergeKubeconfig` is pure and exported, so exercise
  it the same way and run a real `kubectl --kubeconfig` over the output. Point
  `AWS_IAM_AUTHENTICATOR_PATH` at a stub that prints an `ExecCredential` and
  kubectl walks the whole exec path with no AWS account. Cover an existing
  config carrying an entry the old loader rejected — a context with no cluster.
- **`src/schedule.ts`**: pure and electron-free, so its delay arithmetic can be
  exercised directly.

Windows behaviour — Squirrel install and update events, the tray icon, toast
notifications, the login item — needs a real Windows machine. CI proves the
installer builds, not that it installs.
