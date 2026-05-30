//! Persisted application state.
//!
//! These types describe everything Frost keeps between runs. They are
//! storage-agnostic: the Tauri shell decides where to persist them (the Tauri
//! store plugin), while the core only defines the shape and the logic.

use serde::{Deserialize, Serialize};

/// User-provided settings, entered in the Settings dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserConfig {
    /// AWS SSO start URL, e.g. `https://my-org.awsapps.com/start`.
    pub start_url: String,
    /// AWS SSO region the start URL lives in, e.g. `us-east-1`.
    pub region: String,
}

/// An OIDC client registered with AWS SSO via `RegisterClient`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisteredClient {
    pub client_name: String,
    pub client_id: String,
    pub client_secret: String,
    /// Unix timestamp when the client id was issued.
    pub issued_at: i64,
    /// Unix timestamp when the client secret expires.
    pub expires_at: i64,
}

/// A discovered EKS cluster, kept so the tray can show what was found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClusterRef {
    pub name: String,
    pub profile: String,
    pub region: String,
}

/// The full persisted state of the app.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    /// True while a refresh is in progress (drives the tray icon).
    pub is_working: bool,
    pub user_config: Option<UserConfig>,
    /// RFC3339 timestamp of when the current token expires.
    pub expires_at: Option<String>,
    pub access_token: Option<String>,
    pub sso_client: Option<RegisteredClient>,
    pub last_error: Option<String>,
    pub clusters: Vec<ClusterRef>,
}
