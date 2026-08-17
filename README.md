# Frost ❄️

Frost is an app for people using AWS SSO.

AWS SSO requires users to run the `aws sso login` command every once in while to refresh their credentials. Also, users have to setup their workstations by running `aws configure sso` and answering a bunch of questions.

This app tries to automate the process by only requiring the AWS SSO start URL, then getting all the rest of the details directly from AWS SSO's API.

Once a user has successfully logged-in, Frost will add profiles with predictable profile names (see below) to `~/.aws/config`.

When using [AWS SSO with federation](https://docs.aws.amazon.com/singlesignon/latest/userguide/samlfederationconcept.html), such as Google Workspace, Frost can refresh credentials without interrupting the user in most cases.

## The App Window

Frost runs in the menu bar (or tray). Opening it from the tray menu — or with
the global hotkey — shows a settings window with everything in one place:

-   **Login** — the AWS SSO start URL and region. This is all Frost needs to
    get started.
-   **Behavior** — whether Frost refreshes credentials automatically or just
    notifies you, whether the AWS login page opens in a Frost window or in your
    default browser (where passkeys and password managers work), plus the global
    refresh hotkey (`⌘⇧R` by default, rebindable). A **Test** button fires a
    sample notification, which is also how you grant Frost notification
    permission on macOS the first time.
-   **Privacy** — how long run history is kept (7 days by default), and a button
    to erase it immediately.
-   **Credentials** — current token status, the accounts and permission sets you
    can access, and a **Refresh Now** button.
-   **EKS** — the clusters discovered on the last scan.
-   **Activity** — a log of recent refresh runs. Open any run to see each step
    (token, profiles, EKS discovery), what it found, and the error if it failed.

Frost has no backend. Your token, profiles, and run history are stored in a
local configuration file and nothing is transmitted anywhere — no analytics, no
telemetry, no crash reporting.

## Security Keys and Passkeys

When you sign in through Frost's own login window (the default — see
**Behavior** above for the default-browser alternative), identity providers
often ask for a hardware key (YubiKey and friends), a passkey, or a saved
password. Those requests used to be invisible: the page simply sat there, with
nothing to say it was waiting for you to touch anything.

Frost now shows a small notice at the bottom of the login window for as long as
a request is pending — "Touch your security key", "Confirm with your passkey" —
and it disappears the moment the request completes or is cancelled. If the wait
drags on, the notice suggests what to try. And if you've switched to another app
in the meantime, the Dock icon (or the taskbar entry) asks for your attention
and the window title says what's pending, so a key waiting for a touch can't go
unnoticed.

If your key holds several credentials for the same identity provider, Frost asks
which account to sign in with instead of failing the sign-in.

## Profile Name Generation

Profile names are generated automatically using the AWS account name and the permission set name. For example, let's assume a user is defined with the following accounts and permission sets:

| AWS Account     | Permission Sets                      |
| --------------- | ------------------------------------ |
| ACME Main       | AdministratorAccess, PowerUserAccess |
| ACME Testing    | PowerUserAccess, BillingAccess       |
| ACME Production | AdministratorAccess, PowerUserAccess |

Then, the following profiles would be generated:

-   acme-main-administratoraccess
-   acme-main-poweruseraccess
-   acme-testing-poweruseraccess
-   acme-testing-billingaccess
-   acme-production-administratoraccess
-   acme-production-poweruseraccess

### Short Names

This is fine, but the names could be shortened by adding #short-names to the AWS account name.

To do that, [Change the AWS account names](https://aws.amazon.com/premiumsupport/knowledge-center/change-organizations-name/) you wish to shorten.

Using the example above, let's say we've changed the account names to:

| AWS Account             | Permission Sets                      |
| ----------------------- | ------------------------------------ |
| ACME Main (#main)       | AdministratorAccess, PowerUserAccess |
| ACME Testing (#test)    | PowerUserAccess, BillingAccess       |
| ACME Production (#prod) | AdministratorAccess, PowerUserAccess |

The profiles would now be named:

-   main-administratoraccess
-   main-poweruseraccess
-   test-poweruseraccess
-   test-billingaccess
-   prod-administratoraccess
-   prod-poweruseraccess

As for permission set names, you should try to use short names for those. Still, in case you've already used the predefined permission set names, Frost will automatically shorten them by:

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

So we end up with these profiles:

-   main-admin
-   main-poweruser
-   test-poweruser
-   test-billing
-   prod-admin
-   prod-poweruser

### Region Selection

In some cases an AWS account should have a different default region than the one used by AWS SSO.

For example, your AWS SSO may have been created in `us-east-1` but one of the accounts has all of its services in `eu-west-1`. In this case, you'd like `~/.aws/config` to have `region = eu-west-1` for that specific account so that users don't have to pass a region to every CLI/API call.

To do that, add an `@region` to the account name.

In the example above, if the `ACME Testing` account is mainly used in `eu-west-1` we'd rename it to `ACME Testing (#test @eu-west-1)`.

## Sharing `~/.aws/config` With Other Tools

Frost doesn't own your `~/.aws/config` file, it only owns the profiles it wrote there. Every profile Frost generates is marked with a comment:

```ini
[profile main-admin]
# frost:managed - Frost updates and removes this profile. Delete this line to take it over.
sso_start_url = https://acme.awsapps.com/start
sso_region = us-east-1
sso_account_id = 123456789012
sso_role_name = AdministratorAccess
region = us-east-1
output = json
```

On every refresh, Frost rewrites the profiles carrying that marker, removes the ones that no longer exist in AWS SSO, and leaves everything else in the file exactly as it is. So your `[default]` profile, hand-written profiles, `[sso-session ...]` sections and comments all survive.

A few consequences worth knowing:

-   **Upgrading from an older version doesn't duplicate anything.** Older versions of Frost overwrote the whole file and wrote no marker. On the first refresh after upgrading, any unmarked profile whose name and contents are exactly what Frost would generate is adopted (marked as Frost's) instead of being added a second time.
-   **Deleting the marker takes the profile back.** Frost will stop updating or removing that profile. Note that it also stops keeping it in sync with AWS SSO.
-   **Frost never overwrites a profile it doesn't own.** If a profile you wrote yourself happens to have the same name as a generated one, Frost keeps yours and skips writing its own (it logs a warning when this happens).

## EKS Cluster Discovery

In addition to refreshing credentials automatically, Frost will scan for EKS clusters every time it obtains new credentials. The clusters will be saved in `~/.kube/config`.

The scan works by getting the list of regions, then trying to list EKS clusters in each region with every profile detected from AWS SSO.

This method may result in some errors as it makes sense that some profiles don't have access to EKS. This is fine as only successful calls to `eks:DescribeCluster` will result in an entry in `~/.kube/config`.

Authentication to the clusters uses a copy of [AWS IAM Authenticator](https://github.com/kubernetes-sigs/aws-iam-authenticator) embedded within the app. This allows using the app without installing AWS CLI.
