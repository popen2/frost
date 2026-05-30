//! Generation of `~/.aws/config` profile names and contents.
//!
//! Ported from the original `src/profiles.ts`. The rules:
//!   * Account names may carry a `#short-name` tag and an `@region` tag.
//!   * Permission-set names are shortened via a known table, else slugified.
//!   * A profile is emitted per (account, role) pair, named `account-role`.

use crate::config::UserConfig;
use serde::{Deserialize, Serialize};

/// AWS-predefined permission sets mapped to their short forms.
fn predefined_short_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "AdministratorAccess" => "admin",
        "Billing" => "billing",
        "DatabaseAdministrator" => "dba",
        "DataScientist" => "datasci",
        "NetworkAdministrator" => "netadmin",
        "PowerUserAccess" => "poweruser",
        "SecurityAudit" => "secaudit",
        "SupportUser" => "support",
        "SystemAdministrator" => "sysadmin",
        "ViewOnlyAccess" => "viewonly",
        _ => return None,
    })
}

/// An AWS account as returned by SSO `ListAccounts`.
#[derive(Debug, Clone)]
pub struct Account {
    pub account_id: String,
    pub account_name: String,
}

/// A role (permission set) available to the user in an account.
#[derive(Debug, Clone)]
pub struct Role {
    pub account_id: String,
    pub role_name: String,
}

/// The contents written under `[profile <name>]` in `~/.aws/config`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileContents {
    pub sso_start_url: String,
    pub sso_region: String,
    pub sso_account_id: String,
    pub sso_role_name: String,
    pub region: String,
    pub output: String,
}

/// A generated AWS profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub account_name: String,
    pub role_name: String,
    pub contents: ProfileContents,
}

/// Extract the `#short-name` tag from an account name, or slugify the name.
fn short_account_name(name: &str) -> String {
    // First `#tag` of word characters / dashes wins.
    if let Some(m) = regex_first_group(name, r"#([-_a-zA-Z0-9]+)") {
        return m;
    }
    slug::slugify(name)
}

/// Extract a preferred region from an `@region` tag in the account name.
fn preferred_account_region(name: &str) -> Option<String> {
    regex_first_group(name, r"@([a-zA-Z]+-[a-zA-Z]+-[0-9]+)")
}

/// Shorten a permission-set name via the known table, else slugify it.
fn short_permission_set_name(name: &str) -> String {
    predefined_short_name(name)
        .map(str::to_owned)
        .unwrap_or_else(|| slug::slugify(name))
}

/// Run `pattern` against `text` and return the first capture group.
fn regex_first_group(text: &str, pattern: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).expect("static regex");
    re.captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
}

/// Build the full set of profiles from accounts + roles.
pub fn generate_profiles(
    user_config: &UserConfig,
    accounts: &[Account],
    roles: &[Role],
) -> Vec<Profile> {
    roles
        .iter()
        .map(|role| {
            let account = accounts.iter().find(|a| a.account_id == role.account_id);
            let account_name = account
                .map(|a| short_account_name(&a.account_name))
                .unwrap_or_default();
            let region = account
                .and_then(|a| preferred_account_region(&a.account_name))
                .unwrap_or_else(|| user_config.region.clone());
            let role_name = short_permission_set_name(&role.role_name);

            Profile {
                name: format!("{account_name}-{role_name}"),
                account_name,
                role_name,
                contents: ProfileContents {
                    sso_start_url: user_config.start_url.clone(),
                    sso_region: user_config.region.clone(),
                    sso_account_id: role.account_id.clone(),
                    sso_role_name: role.role_name.clone(),
                    region,
                    output: "json".to_owned(),
                },
            }
        })
        .collect()
}
