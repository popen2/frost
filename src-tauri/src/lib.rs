use std::{path::PathBuf, sync::Arc};
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

mod browser;
mod commands;
mod state;

pub const SETTINGS_WINDOW: &str = "settings";
const ABOUT_URL: &str = "https://popen2.github.io/frost/";

const TRAY_ICON_FULL: &[u8] = include_bytes!("../icons/TrayIconFull.png");
const TRAY_ICON_EMPTY: &[u8] = include_bytes!("../icons/TrayIconEmpty.png");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_user_config,
            commands::save_user_config,
            commands::refresh_now,
            commands::close_settings,
        ])
        .setup(|app| {
            // Menu-bar agent: no Dock tile, no CMD-Tab entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Load persisted config and register as shared state.
            let initial = state::load(&app.handle().clone());
            let shared: state::SharedState = Arc::new(Mutex::new(initial));
            app.manage(shared);

            let tray_icon = Image::from_bytes(TRAY_ICON_FULL)?;

            let refresh = MenuItemBuilder::with_id("refresh", "Refresh now").build(app)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings\u{2026}").build(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let about = MenuItemBuilder::with_id("about", "About Frost").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&refresh, &sep1, &settings, &sep2, &about, &quit])
                .build()?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "refresh" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(err) = run_refresh(&app).await {
                                log::warn!("[menu] refresh failed: {err}");
                            }
                        });
                    }
                    "settings" => {
                        if let Err(err) = open_settings(app) {
                            log::warn!("[menu] open settings failed: {err}");
                        }
                    }
                    "about" => {
                        if let Err(err) = app.opener().open_url(ABOUT_URL, None::<&str>) {
                            log::warn!("[menu] open about: {err}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Check for an update in the background — if there's one waiting,
            // download and install so the next launch is on the new version.
            spawn_update_check(app.handle().clone());

            // Open settings if not yet configured; otherwise schedule a refresh.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let cfg_present = {
                    let state = app_handle.state::<state::SharedState>();
                    let guard = state.lock().await;
                    guard.user_config.is_some()
                };
                if cfg_present {
                    if let Err(err) = run_refresh(&app_handle).await {
                        log::warn!("[startup] refresh failed: {err}");
                    }
                } else {
                    let _ = open_settings(&app_handle);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Open (or focus) the Settings window.
fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(SETTINGS_WINDOW) {
        existing.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Frost — Settings")
        .inner_size(460.0, 280.0)
        .resizable(false)
        .center()
        .build()?;
    Ok(())
}

/// Run a full credential refresh and persist the resulting state.
pub async fn run_refresh(app: &AppHandle) -> frost_aws::error::AwsResult<()> {
    set_tray_working(app, true);

    let state = app.state::<state::SharedState>();
    let browser = browser::SystemLoginBrowser::new(app.clone());
    let authenticator = authenticator_path(app).await;

    let result = {
        let mut cfg = state.lock().await;
        let r = frost_aws::refresh::refresh(&mut cfg, &browser, &authenticator).await;
        if let Err(err) = &r {
            cfg.last_error = Some(err.to_string());
        }
        // Always persist whatever we have (token, client, last_error).
        let _ = state::save(app, &cfg);
        r
    };

    set_tray_working(app, false);
    result
}

/// Resolve the `aws-iam-authenticator` executable.
///
/// Precedence: `AWS_IAM_AUTHENTICATOR_PATH` env override (for development) →
/// the bundled resource that CI ships alongside the app → bare name on `$PATH`
/// as a last resort.
async fn authenticator_path(app: &AppHandle) -> String {
    if let Ok(p) = std::env::var("AWS_IAM_AUTHENTICATOR_PATH") {
        return p;
    }
    if let Some(p) = bundled_authenticator(app).await {
        return p.to_string_lossy().into_owned();
    }
    "aws-iam-authenticator".to_owned()
}

async fn bundled_authenticator(app: &AppHandle) -> Option<PathBuf> {
    let candidate = app
        .path()
        .resource_dir()
        .ok()?
        .join("resources")
        .join("aws-iam-authenticator");
    tokio::fs::try_exists(&candidate)
        .await
        .unwrap_or(false)
        .then_some(candidate)
}

fn spawn_update_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_updater::UpdaterExt;
        let updater = match app.updater_builder().build() {
            Ok(u) => u,
            Err(e) => {
                log::warn!("[updater] build failed: {e}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                log::info!("[updater] update available: {}", update.version);
                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                    log::warn!("[updater] install failed: {e}");
                }
            }
            Ok(None) => log::debug!("[updater] up to date"),
            Err(e) => log::debug!("[updater] check failed: {e}"),
        }
    });
}

fn set_tray_working(app: &AppHandle, working: bool) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    let bytes: &[u8] = if working {
        TRAY_ICON_EMPTY
    } else {
        TRAY_ICON_FULL
    };
    if let Ok(image) = Image::from_bytes(bytes) {
        let _ = tray.set_icon(Some(image));
    }
}
