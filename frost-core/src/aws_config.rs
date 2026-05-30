//! Rendering of `~/.aws/config` and the AWS SSO token cache.
//!
//! Ported from `src/aws-config.ts`. These functions are pure (they return
//! strings / filenames); the shell layer is responsible for writing them to
//! disk under `~/.aws`.

use crate::{config::UserConfig, profiles::Profile};
use sha1::{Digest, Sha1};

/// Render the full `~/.aws/config` body for the given profiles.
///
/// Matches the original output: one `[profile <name>]` section per profile,
/// `key = value` pairs with surrounding whitespace, blocks separated by a
/// blank line.
pub fn render_aws_config(profiles: &[Profile]) -> String {
    profiles
        .iter()
        .map(render_profile)
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_profile(profile: &Profile) -> String {
    let c = &profile.contents;
    let mut out = format!("[profile {}]\n", profile.name);
    for (key, value) in [
        ("sso_start_url", c.sso_start_url.as_str()),
        ("sso_region", c.sso_region.as_str()),
        ("sso_account_id", c.sso_account_id.as_str()),
        ("sso_role_name", c.sso_role_name.as_str()),
        ("region", c.region.as_str()),
        ("output", c.output.as_str()),
    ] {
        out.push_str(&format!("{key} = {value}\n"));
    }
    out
}

/// The AWS-CLI-compatible cache filename for a start URL: `sha1(url).json`.
pub fn sso_cache_filename(start_url: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(start_url.as_bytes());
    format!("{}.json", hex::encode(hasher.finalize()))
}

/// Render the JSON body of an SSO token cache entry.
pub fn render_sso_cache(user_config: &UserConfig, access_token: &str, expires_at: &str) -> String {
    let body = serde_json::json!({
        "startUrl": user_config.start_url,
        "region": user_config.region,
        "accessToken": access_token,
        "expiresAt": expires_at,
    });
    body.to_string()
}
