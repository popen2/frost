//! Integration tests for profile-name generation.
//!
//! Everything is exercised through the public `generate_profiles` entry point
//! — the helpers (short-name extraction, region tag, predefined permission-set
//! short forms, slug fallback) stay private to the module and are tested
//! transitively here.

use frost_core::{
    config::UserConfig,
    profiles::{Account, Role, generate_profiles},
};

fn cfg() -> UserConfig {
    UserConfig {
        start_url: "https://acme.awsapps.com/start".to_owned(),
        region: "us-east-1".to_owned(),
    }
}

fn account(id: &str, name: &str) -> Account {
    Account {
        account_id: id.into(),
        account_name: name.into(),
    }
}

fn role(account_id: &str, name: &str) -> Role {
    Role {
        account_id: account_id.into(),
        role_name: name.into(),
    }
}

#[test]
fn predefined_permission_set_short_form_is_applied() {
    let profiles = generate_profiles(
        &cfg(),
        &[account("111", "Acme (#a)")],
        &[
            role("111", "AdministratorAccess"),
            role("111", "PowerUserAccess"),
        ],
    );
    let names: Vec<_> = profiles.iter().map(|p| p.name.as_str()).collect();
    assert!(names.contains(&"a-admin"));
    assert!(names.contains(&"a-poweruser"));
}

#[test]
fn unknown_permission_set_is_slugified() {
    let profiles = generate_profiles(
        &cfg(),
        &[account("111", "Acme (#a)")],
        &[role("111", "Custom Role")],
    );
    assert_eq!(profiles[0].name, "a-custom-role");
}

#[test]
fn short_tag_overrides_account_name() {
    let profiles = generate_profiles(
        &cfg(),
        &[account("111", "ACME Production (#prod)")],
        &[role("111", "AdministratorAccess")],
    );
    assert_eq!(profiles[0].name, "prod-admin");
}

#[test]
fn account_name_without_tag_is_slugified() {
    let profiles = generate_profiles(
        &cfg(),
        &[account("111", "ACME Main")],
        &[role("111", "AdministratorAccess")],
    );
    assert_eq!(profiles[0].name, "acme-main-admin");
}

#[test]
fn region_tag_overrides_sso_region() {
    let profiles = generate_profiles(
        &cfg(),
        &[account("111", "ACME Testing (#test @eu-west-1)")],
        &[role("111", "PowerUserAccess")],
    );
    let p = &profiles[0];
    assert_eq!(p.name, "test-poweruser");
    assert_eq!(p.contents.region, "eu-west-1");
    assert_eq!(p.contents.sso_account_id, "111");
    assert_eq!(p.contents.sso_role_name, "PowerUserAccess");
    assert_eq!(p.contents.output, "json");
}

#[test]
fn region_falls_back_to_sso_region_when_no_tag() {
    let profiles = generate_profiles(
        &cfg(),
        &[account("222", "ACME Main (#main)")],
        &[role("222", "AdministratorAccess")],
    );
    assert_eq!(profiles[0].name, "main-admin");
    assert_eq!(profiles[0].contents.region, "us-east-1");
}
