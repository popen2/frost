# AGENTS.md

Orientation for working on Frost. Read this before touching code, the build
config, the release pipeline, or commit messages.

## What this is

Frost is a macOS / Linux **menu-bar app** that automates AWS Identity Center
(SSO) — point it at a start URL, it handles the device-authorization sign-in
in the user's default browser, writes `~/.aws/config` profiles, refreshes the
token before it expires, and discovers EKS clusters into `~/.kube/config`.

The app is a **Tauri 2 shell on top of a Rust workspace**. The original
Electron / TypeScript app was retired in the `v0.3.0` line — see "Upgrade
path" below for the one-time Squirrel.Mac bridge that carries existing
Electron users across.

## Layout

| Path | What it is |
| --- | --- |
| `frost-core/` | Pure-logic Rust crate: profile-name generation, `~/.aws/config` + SSO cache rendering, `~/.kube/config` name-selection + merge. No GUI / AWS-SDK deps. |
| `frost-aws/` | `aws-sdk-rust` adapter: OIDC device-auth login, SSO accounts / roles, EKS discovery, file writes, end-to-end `refresh`. The login surface is behind a `LoginBrowser` trait so the shell provides the actual window. |
| `src-tauri/` | Tauri 2 shell — tray, settings, commands, updater, the `SystemLoginBrowser` impl. `identifier = "frost"` and `LSUIElement` are deliberate (see "Upgrade path"). |
| `src-tauri/resources/` | Files bundled into the `.app` / `.AppImage` / `.deb`. CI drops the per-arch `aws-iam-authenticator` here before `cargo tauri build`. |
| `ui/index.html` | Tauri frontend (static HTML; no JS bundler). |
| `docs/` | The landing site shipped to GitHub Pages (`pages.yaml`). |
| `.github/workflows/` | CI + release pipelines (see below). |

## Commit conventions

We use **Conventional Commits** for both commit messages and PR titles.
`.github/release-drafter.yml` reads PR titles to apply labels, group the
changelog, and pick the next version — so this is load-bearing, not cosmetic.

Format: `type(scope): subject` — for example, `feat(app): add settings dialog`
or `fix(aws): retry SlowDownException with backoff`. Use `!` for breaking
changes: `feat(api)!: drop legacy device-code flow`.

**Types** (drive the changelog category + SemVer bump):

| Type | Label(s) | Changelog | Version |
| --- | --- | --- | --- |
| `feat` | `feature`, `minor` | 🚀 Features | minor |
| `fix` | `fix` | 🐛 Bug Fixes | patch |
| `docs` | `docs` | 📝 Documentation | patch |
| `ci`, `build` | `ci` | 🤖 CI & Build | patch |
| `chore`, `refactor`, `perf`, `style`, `test` | `chore` | 🧰 Maintenance | patch |
| any with `!` | `major` | (in its type's section) | major |

**Scopes** are the area the change touches:

- `core` — `frost-core`
- `aws` — `frost-aws`
- `app` — `src-tauri` (the Tauri shell)
- `tauri` — Tauri build pipeline
- `release` — `release.yaml`
- `labeler` — release-drafter / autolabeler config
- `agents` — this file
- (omit the scope if it doesn't fit one)

## Workflow

- Branch off `main`. One topic per PR.
- The PR title is the changelog line — pick it carefully.
- When rebasing onto `main`, always prefer `--force-with-lease` over
  `--force` (it has saved this branch from data loss before).

## Commands

The whole project is a Cargo workspace:

- `cargo fmt --all --check` — enforced in CI (stable rustfmt, no committed
  `rustfmt.toml`). When running locally with a nightly toolchain, prefer
  `group_imports = "One"` and `imports_granularity = "Crate"` for tidier
  `use` blocks — both are still nightly-only rustfmt options, so they live
  here as a personal convention rather than a project config, until they
  stabilise.
- `cargo clippy -p frost-core -p frost-aws --all-targets -- -D warnings` —
  what CI runs.
- `cargo test -p frost-core -p frost-aws` — `frost-core` has 18 unit tests
  exercising the trickiest pure logic.
- `cargo tauri dev` / `cargo tauri build` — run / build the Tauri app.
  Requires the
  [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)
  (`build.yaml` documents the Linux apt list it installs).

## Rust dependency notes

- **AWS SDK for Rust 1.x** for OIDC / SSO / EKS. The OIDC + SSO portal
  clients are built without a credentials provider (the access token is the
  auth); per-profile EKS clients use
  `aws_config::defaults().profile_name(...)`, which reads the
  `~/.aws/config` profile + the SSO cache file we write.
- `aws-sdk-ec2` is deliberately **not** pulled in. EKS discovery iterates a
  curated `REGIONS` constant in `frost-aws::eks` instead of calling
  `DescribeRegions`, because `aws-sdk-ec2` is one of the largest crates in
  the ecosystem and discovery is best-effort either way.
- Login is abstracted behind `frost_aws::browser::LoginBrowser`. The Tauri
  shell provides `SystemLoginBrowser`, which opens the verification URL in
  the user's default browser via `tauri-plugin-opener` — this is what makes
  YubiKey / FIDO2 / WebAuthn work, since `WKWebView` can't.
- YAML: `serde_yaml = "0.9"` (deprecated upstream but still the de-facto
  choice for the kubeconfig shape).

## AWS IAM Authenticator

The `aws-iam-authenticator` binary is bundled into the `.app` / `.AppImage` /
`.deb` as a Tauri resource so users don't need the AWS CLI. It is **not**
committed — the `build.yaml` workflow downloads the per-arch binary at
build time, drops it in `src-tauri/resources/aws-iam-authenticator`, and
Tauri picks it up via `bundle.resources` in `tauri.conf.json`. The version is
pinned as `AWS_IAM_AUTHENTICATOR_VERSION` in `build.yaml`.

At runtime, `src-tauri/src/lib.rs::authenticator_path` resolves it in this
order:

1. `AWS_IAM_AUTHENTICATOR_PATH` env var (for `cargo tauri dev`).
2. The bundled resource: `app.path().resource_dir()?/resources/aws-iam-authenticator`.
3. Bare `"aws-iam-authenticator"` on `$PATH` as a last resort.

## Self-update

The app updates itself in place via `tauri-plugin-updater`, pointing at:

```
https://github.com/popen2/frost/releases/latest/download/latest.json
```

That URL is the GitHub Releases redirect to whatever the latest release's
`latest.json` is, so any tag published by `release.yaml` is automatically
served to running clients.

`src-tauri/src/lib.rs::spawn_update_check` fires on startup, downloads + installs
in the background, and logs the result. Updates are verified against an
ed25519 pubkey embedded in `tauri.conf.json` under `plugins.updater.pubkey`
(committed deliberately — only the matching private key can sign, and the
public key is what the running app uses to verify downloads, so it has to
ship with the app).

The matching **private key + password live as CI secrets**, not in the repo:

| Secret | What |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | minisign private key generated by `cargo tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password chosen when generating the key |

`build.yaml`'s `Build & sign` step picks both up from the environment. To
rotate the keypair: regenerate with `cargo tauri signer generate -w
~/.tauri/frost.key`, commit the new public key into `tauri.conf.json`, and
replace both repo secrets with the new private key + password. If releases
already exist under the old key, keep it around long enough to ship one
transitional release, otherwise running clients will reject the new
signature.

Updater artifacts are produced by `bundle.createUpdaterArtifacts` (a Tauri v2
flag), **not** by an `updater` bundle target — there is no such target in v2,
and listing one makes `tauri.conf.json` fail schema validation (breaking even
`cargo tauri dev`). The committed config leaves the flag off so the project
builds without any signing key; the release-only `Enable updater artifacts`
step in `build.yaml` sets it to `true` in `tauri.conf.json` in place (same
pattern as the version stamp) before the build. Once the flag is on, a build
with no `TAURI_SIGNING_PRIVATE_KEY` fails with a missing-signing-key error —
which is why that step is gated on `inputs.publish`, keeping PR builds
secret-free.

## CI / release pipeline

Five workflows.

- **`build.yaml`** (reusable) — darwin (arm64 + x86_64) and linux
  (x86_64) matrix. Installs Rust + Linux deps, downloads the per-arch
  `aws-iam-authenticator` into `src-tauri/resources/`, optionally stamps the
  version into `Cargo.toml` + `tauri.conf.json`, stages the notarization
  `.p8`, then delegates to `tauri-apps/tauri-action`. Apple Developer ID
  signing identity is hard-coded — update it there if the Developer ID
  changes. Both PR and release builds produce `app` + `dmg`; release builds
  additionally flip on `createUpdaterArtifacts` (the `Enable updater
  artifacts` step) to emit the signed updater archive + `.sig` (and need the
  Tauri signing secrets).
- **`ci.yaml`** (🔍 Build) — runs on PRs to `main` and pushes to `main`.
  Lints the Rust workspace (cargo fmt / clippy / test on `frost-core` +
  `frost-aws`), then calls `build.yaml` with `publish: false`. On
  pushes also updates the release-drafter draft.
- **`release.yaml`** (🚀 Release Version) — runs on `v*` tag pushes. Strips
  the leading `v` and calls `build.yaml` with `publish: true` —
  attaching the signed bundles, `.sig`, and `latest.json` to the GitHub
  release that release-drafter staged.
- **`pages.yaml`** — deploys `docs/` to GitHub Pages on push to `main` when
  `docs/**` changes.
- **`autolabeler.yaml`** — runs `release-drafter/autolabeler` on PR open /
  reopen / sync, reading rules from `.github/release-drafter.yml` (see
  "Commit conventions" above for the title patterns).

The released version comes from the tag (stamped in CI), so **don't bump
`version` in `Cargo.toml` / `tauri.conf.json` manually**. Releases are
draft-then-publish: release-drafter maintains a draft on every push to
`main`; the human who clicks "Publish" creates the tag and triggers
`release.yaml`.

## macOS signing / notarization

`tauri-action` handles the keychain + notarytool plumbing. Required repo
secrets:

| Secret | What |
| --- | --- |
| `MAC_CERTS` | base64 of the Developer ID Application `.p12` |
| `MAC_CERTS_PASSWORD` | password for that `.p12` |
| `APPLE_API_KEY` | notarytool API Key **ID** (e.g. `ABCDE12345`) |
| `APPLE_API_ISSUER` | notarytool API Issuer UUID |
| `APPLE_API_AUTHKEY_BASE64` | base64 of the `AuthKey_<ID>.p8` file |
| `TAURI_SIGNING_PRIVATE_KEY` | ed25519 update key (only needed for release publishes) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for that key |

The `Stage Apple API key for notarization` step in `build.yaml` writes
the `.p8` to `~/private_keys/AuthKey_<APPLE_API_KEY>.p8` and exports
`APPLE_API_KEY_PATH` for `tauri-action` to pick up. The signing identity
(`APPLE_SIGNING_IDENTITY`) is hard-coded — keep it identical to whatever the
Electron app shipped under so Squirrel.Mac accepts the upgrade bundle (see
below).

This path can only be validated in CI on a macOS runner — it cannot be
validated locally.

## Upgrade path (Electron → Tauri)

The plan was: the first `v0.3.x` release ships the Tauri app as a
Squirrel-compatible `.zip` attached to the same GitHub Release. Existing
`v0.2.x` (Electron) installs auto-update via `update-electron-app`,
Squirrel.Mac swaps the bundle in place, the user relaunches into the Tauri
app, and every subsequent update comes from Tauri's own updater plugin.

For this to work the Tauri build **must** preserve:

- `tauri.conf.json` `identifier`: `"frost"` — exactly equal to the Electron
  app's `CFBundleIdentifier`. Squirrel verifies
  `newBundle.bundleIdentifier == runningApp.bundleIdentifier` and silently
  rejects the update otherwise.
- The same Apple Developer ID + Team ID signature. The designated
  requirement pins both; a wrong identity fails the update with "code failed
  to satisfy specified code requirement".
- Menu-bar agent behavior — `src-tauri/Info.plist` sets `LSUIElement = true`
  and `lib.rs` sets `ActivationPolicy::Accessory` at startup.

The Squirrel-format `.zip` is not yet produced by `build.yaml` — that's
a small step to add when cutting the bridge release (`ditto -c -k --keepParent
Frost.app Frost-darwin-<arch>.zip` after the build, then upload to the
release).

## Verification limits

- Library crates (`frost-core`, `frost-aws`) compile, test, and lint fine
  anywhere with Rust + cargo.
- The Tauri shell (`src-tauri`), macOS signing, notarization, and the
  Squirrel upgrade swap can only be validated on a real macOS host (or a
  macOS CI runner). Anything you ship in those areas needs CI to be the
  source of truth, not a local "should work" claim.
- The landing site is static HTML; opening `docs/index.html` in a browser is
  enough to validate visually. The `pages.yaml` deploy itself is verified
  only by the runner's success.
