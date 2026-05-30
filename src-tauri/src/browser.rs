//! `LoginBrowser` implementation that drives sign-in inside an always-on-top
//! Tauri window, mirroring the previous app's built-in browser.

use frost_aws::{
    browser::LoginBrowser,
    error::{AwsResult, Error},
};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const LOGIN_WINDOW: &str = "login";

pub struct SystemLoginBrowser {
    handle: AppHandle,
}

impl SystemLoginBrowser {
    pub fn new(handle: AppHandle) -> Self {
        Self { handle }
    }
}

impl LoginBrowser for SystemLoginBrowser {
    async fn open(&self, url: &str) -> AwsResult<()> {
        let url: Url = url
            .parse()
            .map_err(|e| Error::Browser(format!("bad login url: {e}")))?;
        let handle = self.handle.clone();
        // Window/webview creation must happen on the main thread on macOS.
        run_on_main(&self.handle, move || open_login_window(&handle, url)).await
    }

    async fn close(&self) {
        let handle = self.handle.clone();
        let _ = run_on_main(&self.handle, move || {
            if let Some(w) = handle.get_webview_window(LOGIN_WINDOW) {
                w.close()
                    .map_err(|e| Error::Browser(format!("close login: {e}")))?;
            }
            Ok(())
        })
        .await;
    }
}

fn open_login_window(handle: &AppHandle, url: Url) -> AwsResult<()> {
    if let Some(w) = handle.get_webview_window(LOGIN_WINDOW) {
        w.navigate(url)
            .map_err(|e| Error::Browser(format!("navigate login: {e}")))?;
        w.set_focus()
            .map_err(|e| Error::Browser(format!("focus login: {e}")))?;
        return Ok(());
    }
    WebviewWindowBuilder::new(handle, LOGIN_WINDOW, WebviewUrl::External(url))
        .title("Frost — Sign in")
        .inner_size(550.0, 700.0)
        .always_on_top(true)
        .focused(true)
        .center()
        .build()
        .map_err(|e| Error::Browser(format!("open login window: {e}")))?;
    Ok(())
}

/// Dispatch `f` onto the main thread and await its result.
async fn run_on_main<F>(handle: &AppHandle, f: F) -> AwsResult<()>
where
    F: FnOnce() -> AwsResult<()> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle
        .run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| Error::Browser(format!("dispatch to main thread: {e}")))?;
    rx.await
        .map_err(|e| Error::Browser(format!("main thread dropped: {e}")))?
}
