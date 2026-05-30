//! Integration tests for the `aws_config` renderers — exercise only the
//! crate's public API.

use frost_core::{
    aws_config::{render_aws_config, render_sso_cache, sso_cache_filename},
    config::UserConfig,
    profiles::{Profile, ProfileContents},
};

fn profile(name: &str, region: &str) -> Profile {
    Profile {
        name: name.to_owned(),
        account_name: "acme".to_owned(),
        role_name: "admin".to_owned(),
        contents: ProfileContents {
            sso_start_url: "https://acme.awsapps.com/start".to_owned(),
            sso_region: "us-east-1".to_owned(),
            sso_account_id: "111".to_owned(),
            sso_role_name: "AdministratorAccess".to_owned(),
            region: region.to_owned(),
            output: "json".to_owned(),
        },
    }
}

#[test]
fn renders_single_profile_block() {
    let cfg = render_aws_config(&[profile("acme-admin", "us-east-1")]);
    let expected = "\
[profile acme-admin]
sso_start_url = https://acme.awsapps.com/start
sso_region = us-east-1
sso_account_id = 111
sso_role_name = AdministratorAccess
region = us-east-1
output = json
";
    assert_eq!(cfg, expected);
}

#[test]
fn separates_blocks_with_blank_line() {
    let cfg = render_aws_config(&[
        profile("acme-admin", "us-east-1"),
        profile("acme-power", "eu-west-1"),
    ]);
    assert!(cfg.contains("output = json\n\n[profile acme-power]"));
}

#[test]
fn cache_filename_is_stable_and_hex() {
    let name = sso_cache_filename("https://acme.awsapps.com/start");
    assert!(name.ends_with(".json"));
    let hex_part = name.trim_end_matches(".json");
    assert_eq!(hex_part.len(), 40);
    assert!(hex_part.chars().all(|c| c.is_ascii_hexdigit()));
    // Deterministic.
    assert_eq!(name, sso_cache_filename("https://acme.awsapps.com/start"));
}

#[test]
fn sso_cache_has_aws_cli_keys() {
    let cfg = UserConfig {
        start_url: "https://acme.awsapps.com/start".to_owned(),
        region: "us-east-1".to_owned(),
    };
    let json = render_sso_cache(&cfg, "tok", "2026-01-01T00:00:00Z");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["startUrl"], "https://acme.awsapps.com/start");
    assert_eq!(v["region"], "us-east-1");
    assert_eq!(v["accessToken"], "tok");
    assert_eq!(v["expiresAt"], "2026-01-01T00:00:00Z");
}
