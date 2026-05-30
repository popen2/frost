//! Tauri commands invoked from the settings webview.

use crate::state::{self, SharedState};
use frost_core::config::UserConfig;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn get_user_config(state: State<'_, SharedState>) -> Result<Option<UserConfig>, String> {
    Ok(state.lock().await.user_config.clone())
}

#[tauri::command]
pub async fn save_user_config(
    app: AppHandle,
    state: State<'_, SharedState>,
    start_url: String,
    region: String,
) -> Result<(), String> {
    {
        let mut cfg = state.lock().await;
        cfg.user_config = Some(UserConfig { start_url, region });
        // Force a fresh login on the next refresh.
        cfg.access_token = None;
        cfg.expires_at = None;
        state::save(&app, &cfg)?;
    }
    // Kick off a refresh in the background so saving doesn't block the dialog.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = crate::run_refresh(&app2).await {
            log::warn!("[save_user_config] refresh failed: {err}");
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn refresh_now(app: AppHandle) -> Result<(), String> {
    crate::run_refresh(&app).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn close_settings(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(crate::SETTINGS_WINDOW) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_regions() -> Vec<String> {
    frost_aws::eks::REGIONS
        .iter()
        .map(|r| r.to_string())
        .collect()
}
