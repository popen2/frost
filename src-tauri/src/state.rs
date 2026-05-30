//! Persisted app state, stored at `~/Library/Application Support/frost/config.json`.

use frost_core::config::AppConfig;
use std::{path::PathBuf, sync::Arc};
use tauri::Manager;
use tokio::sync::Mutex;

pub type SharedState = Arc<Mutex<AppConfig>>;

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    Ok(dir.join("config.json"))
}

/// Load the config from disk; missing or unparseable files yield defaults.
pub fn load(app: &tauri::AppHandle) -> AppConfig {
    let Ok(path) = config_path(app) else {
        return AppConfig::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return AppConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// Persist the config to disk.
pub fn save(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let body = serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize config: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}
