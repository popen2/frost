//! Filesystem side effects: writing `~/.aws/config`, the SSO token cache, and
//! `~/.kube/config`. The rendering itself lives in `frost-core`; this module
//! only decides paths and performs the writes.

use crate::error::AwsResult;
use frost_core::{
    aws_config::{render_aws_config, render_sso_cache, sso_cache_filename},
    config::UserConfig,
    kubeconfig::{ClusterInfo, merge_kubeconfig},
    profiles::Profile,
};
use std::path::PathBuf;

fn home() -> PathBuf {
    // `dirs` is the de-facto crate for OS-aware home/config dir lookups.
    // The unwrap fallback to `.` keeps this infallible (matches the original
    // env-only impl); `home_dir()` only returns `None` in pathological
    // environments with no HOME and no platform fallback.
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn aws_dir() -> PathBuf {
    home().join(".aws")
}

fn kube_config_path() -> PathBuf {
    home().join(".kube").join("config")
}

/// Write the generated profiles to `~/.aws/config`.
pub async fn write_aws_config(profiles: &[Profile]) -> AwsResult<()> {
    let path = aws_dir().join("config");
    let body = render_aws_config(profiles);
    write_file(&path, body.as_bytes()).await
}

/// Write the AWS-CLI-compatible SSO token cache entry.
pub async fn write_sso_cache(
    user_config: &UserConfig,
    access_token: &str,
    expires_at: &str,
) -> AwsResult<()> {
    let path = aws_dir()
        .join("sso")
        .join("cache")
        .join(sso_cache_filename(&user_config.start_url));
    let body = render_sso_cache(user_config, access_token, expires_at);
    write_file(&path, body.as_bytes()).await
}

/// Merge discovered clusters into `~/.kube/config`, preserving existing entries.
pub async fn write_kubeconfig(infos: &[ClusterInfo], authenticator: &str) -> AwsResult<()> {
    let path = kube_config_path();
    let existing = match tokio::fs::read_to_string(&path).await {
        Ok(contents) => Some(contents),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.into()),
    };
    let merged = merge_kubeconfig(existing.as_deref(), infos, authenticator)?;
    write_file(&path, merged.as_bytes()).await
}

async fn write_file(path: &PathBuf, contents: &[u8]) -> AwsResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, contents).await?;
    Ok(())
}
