//! AWS SSO portal calls: enumerate the accounts and roles a token grants.
//!
//! Like OIDC these use the bearer access token rather than SigV4 credentials.

use crate::error::{AwsResult, aws};
use aws_sdk_sso::{
    Client,
    config::{BehaviorVersion, Region},
};
use frost_core::profiles::{Account, Role};

fn client(region: &str) -> Client {
    let conf = aws_sdk_sso::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(region.to_owned()))
        .build();
    Client::from_conf(conf)
}

/// List every AWS account the access token can reach.
pub async fn list_accounts(region: &str, access_token: &str) -> AwsResult<Vec<Account>> {
    let mut stream = client(region)
        .list_accounts()
        .access_token(access_token)
        .into_paginator()
        .items()
        .send();

    let mut accounts = Vec::new();
    while let Some(item) = stream.next().await {
        let info = item.map_err(aws)?;
        accounts.push(Account {
            account_id: info.account_id().unwrap_or_default().to_owned(),
            account_name: info.account_name().unwrap_or_default().to_owned(),
        });
    }
    Ok(accounts)
}

/// List the roles (permission sets) available in a single account.
pub async fn list_account_roles(
    region: &str,
    access_token: &str,
    account_id: &str,
) -> AwsResult<Vec<Role>> {
    let mut stream = client(region)
        .list_account_roles()
        .access_token(access_token)
        .account_id(account_id)
        .into_paginator()
        .items()
        .send();

    let mut roles = Vec::new();
    while let Some(item) = stream.next().await {
        let info = item.map_err(aws)?;
        roles.push(Role {
            account_id: info.account_id().unwrap_or(account_id).to_owned(),
            role_name: info.role_name().unwrap_or_default().to_owned(),
        });
    }
    Ok(roles)
}
