# Frost ❄️

A menu-bar app that takes the friction out of AWS Identity Center (SSO).
Point it at your start URL — Frost handles the sign-in, refreshes credentials
in the background, writes a tidy `~/.aws/config`, and discovers EKS clusters
into `~/.kube/config` along the way.

**[Download the latest release →](https://github.com/popen2/frost/releases/latest)**
· [popen2.github.io/frost](https://popen2.github.io/frost/)

Built with 🦀 **Rust** + **Tauri 2** — native, small, no bundled browser
engine. The app updates itself in place from GitHub Releases; no Homebrew,
no App Store, no package manager. Zero telemetry, zero analytics — every
network call goes to AWS (to do its job) or GitHub (to check for its own
updates).

## What it does

AWS Identity Center requires running `aws sso login` every few hours to
refresh credentials, and `aws configure sso` to set workstations up. Frost
automates both: you only provide the SSO start URL, and it gets everything
else from the SSO API.

Once you've signed in, Frost writes `~/.aws/config` with predictable profile
names (see below) and keeps your access tokens fresh so your shell, scripts,
and long-running jobs don't trip over expired credentials. With AWS SSO + an
IdP like Google Workspace, refreshes are usually silent.

Sign-in happens in your default browser, so any MFA flow — TOTP, push
notifications, YubiKey / FIDO2 / WebAuthn, passkeys — works exactly as it
does anywhere else.

## Profile name generation

Profile names are generated automatically from the AWS account name and the
permission set name. For example, assume the following:

| AWS Account     | Permission Sets                      |
| --------------- | ------------------------------------ |
| ACME Main       | AdministratorAccess, PowerUserAccess |
| ACME Testing    | PowerUserAccess, BillingAccess       |
| ACME Production | AdministratorAccess, PowerUserAccess |

Frost will generate:

-   acme-main-administratoraccess
-   acme-main-poweruseraccess
-   acme-testing-poweruseraccess
-   acme-testing-billingaccess
-   acme-production-administratoraccess
-   acme-production-poweruseraccess

### Short names

These work, but they're long. Add a `#short-name` tag to your AWS account
name and Frost will use it instead.
[How to rename an AWS account.](https://aws.amazon.com/premiumsupport/knowledge-center/change-organizations-name/)

| AWS Account             | Permission Sets                      |
| ----------------------- | ------------------------------------ |
| ACME Main (#main)       | AdministratorAccess, PowerUserAccess |
| ACME Testing (#test)    | PowerUserAccess, BillingAccess       |
| ACME Production (#prod) | AdministratorAccess, PowerUserAccess |

Now the profiles are:

-   main-administratoraccess
-   main-poweruseraccess
-   test-poweruseraccess
-   test-billingaccess
-   prod-administratoraccess
-   prod-poweruseraccess

Frost also shortens the standard AWS-managed permission set names:

| Predefined Permission Set Name | Shortened Name |
| ------------------------------ | -------------- |
| AdministratorAccess            | admin          |
| Billing                        | billing        |
| DatabaseAdministrator          | dba            |
| DataScientist                  | datasci        |
| NetworkAdministrator           | netadmin       |
| PowerUserAccess                | poweruser      |
| SecurityAudit                  | secaudit       |
| SupportUser                    | support        |
| SystemAdministrator            | sysadmin       |
| ViewOnlyAccess                 | viewonly       |

So the final names are:

-   main-admin
-   main-poweruser
-   test-poweruser
-   test-billing
-   prod-admin
-   prod-poweruser

### Per-account region

If an account belongs in a different region than your Identity Center, add
`@region` to the account name and Frost will use it as the profile's default
`region`. For example, `ACME Testing (#test @eu-west-1)` tells Frost to write
`region = eu-west-1` for that account's profiles so you can drop `--region`
from your CLI calls.

## EKS cluster discovery

Every credential refresh, Frost probes each AWS region for EKS clusters with
every detected profile and writes the findings to `~/.kube/config`. Profiles
without EKS access just produce errors that Frost silently ignores. Context
names are derived deterministically from cluster info, so every teammate
ends up with the same names in their kubeconfig — scripts and runbooks can
reference clusters by short, predictable names without per-developer ARN
aliases.

When clusters share a name across regions, accounts, or roles, Frost adds
back only what's needed to tell them apart (e.g. `production:eu-west-1`).

Authentication uses a copy of
[AWS IAM Authenticator](https://github.com/kubernetes-sigs/aws-iam-authenticator)
bundled into the app, so `kubectl` works out of the box — no AWS CLI install
required.

## Installing & updating

Download the `.dmg` (macOS) or `.AppImage` / `.deb` (Linux) for your
architecture from the
[latest release](https://github.com/popen2/frost/releases/latest), open it,
and that's the whole install.

Updates happen automatically in the background — Frost checks GitHub
Releases on launch, downloads the new bundle if there is one, and applies
it next time you start the app. No `brew upgrade`, no manual re-downloads.

## Building from source

Frost is a Cargo workspace plus a Tauri shell:

```
frost-core/   # pure logic — profile generation, kubeconfig, etc.
frost-aws/    # AWS SDK adapters — SSO login, accounts, EKS
src-tauri/           # Tauri 2 app — tray, settings, menu-bar agent
ui/                  # static HTML for the Settings window
docs/                # the landing site shipped to GitHub Pages
```

You'll need a recent Rust toolchain plus the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your
platform. Then:

```sh
cargo test -p frost-core -p frost-aws   # 18 unit tests, no network
cargo tauri dev                          # run the app
cargo tauri build                        # produce a signed bundle (needs Apple secrets on macOS)
```

See [AGENTS.md](AGENTS.md) for contributor conventions (Conventional Commits
drive the changelog + version bumps) and the CI / release pipeline.

## License

Apache-2.0. See [LICENSE](LICENSE).
