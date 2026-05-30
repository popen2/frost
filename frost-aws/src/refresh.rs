//! The end-to-end credential refresh, orchestrating OIDC + SSO + EKS.
//!
//! Mirrors the original `refresh()` in `aws-sso.ts`: obtain a token (logging in
//! via the browser if needed), regenerate `~/.aws/config`, then discover EKS
//! clusters and update `~/.kube/config`. State is threaded through `AppConfig`
//! so the shell can persist it; this function does not own persistence.

use crate::{
    browser::LoginBrowser,
    eks,
    error::{AwsResult, Error},
    fs, oidc, sso,
};
use frost_core::{
    config::{AppConfig, ClusterRef, RegisteredClient, UserConfig},
    profiles::generate_profiles,
};
use std::time::{SystemTime, UNIX_EPOCH};

/// Perform a full refresh, mutating `config` with the new token, client, and
/// discovered clusters. `authenticator` is the path to `aws-iam-authenticator`.
pub async fn refresh(
    config: &mut AppConfig,
    browser: &impl LoginBrowser,
    authenticator: &str,
) -> AwsResult<()> {
    config.last_error = None;

    let user = config
        .user_config
        .clone()
        .ok_or(Error::NotConfigured("AWS SSO start URL"))?;

    let client = ensure_client(config, &user).await?;
    let token = oidc::login(&user.region, &client, &user.start_url, browser).await?;

    let expires_at = token.expires_at.to_rfc3339();
    config.access_token = Some(token.access_token.clone());
    config.expires_at = Some(expires_at.clone());
    fs::write_sso_cache(&user, &token.access_token, &expires_at).await?;

    let accounts = sso::list_accounts(&user.region, &token.access_token).await?;
    let mut roles = Vec::new();
    for account in &accounts {
        roles.extend(
            sso::list_account_roles(&user.region, &token.access_token, &account.account_id).await?,
        );
    }

    let profiles = generate_profiles(&user, &accounts, &roles);
    fs::write_aws_config(&profiles).await?;

    let clusters = eks::discover(&profiles).await;
    config.clusters = clusters
        .iter()
        .map(|c| ClusterRef {
            name: c.cluster_name.clone(),
            profile: c.profile_name.clone(),
            region: c.region.clone(),
        })
        .collect();
    fs::write_kubeconfig(&clusters, authenticator).await?;

    Ok(())
}

/// Return a usable OIDC client, registering (or re-registering) as needed.
async fn ensure_client(config: &mut AppConfig, user: &UserConfig) -> AwsResult<RegisteredClient> {
    let now = now_unix();
    if let Some(existing) = &config.sso_client
        && existing.expires_at > now
    {
        return Ok(existing.clone());
    }

    let name = config
        .sso_client
        .as_ref()
        .map(|c| c.client_name.clone())
        .unwrap_or_else(|| format!("Frost-{}", now));

    let client = oidc::register_client(&user.region, &name).await?;
    config.sso_client = Some(client.clone());
    Ok(client)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
