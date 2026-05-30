//! `LoginBrowser` implementation that opens the verification URL in the user's
//! default browser.
//!
//! We deliberately don't use a Tauri `WebviewWindow` for sign-in: on macOS that
//! is `WKWebView`, which Apple does NOT extend WebAuthn to for FIDO2 security
//! keys (YubiKey & friends). Handing the URL to the system browser keeps the
//! IdP login surface a real browser, so hardware keys, passkeys, and any
//! corporate browser extensions just work.
//!
//! The trade-off is that we don't own the login window, so `close()` is a
//! no-op — the user can close their browser tab when they're done.

use frost_aws::{
    browser::LoginBrowser,
    error::{AwsResult, Error},
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

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
        self.handle
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| Error::Browser(format!("open url: {e}")))
    }

    async fn close(&self) {
        // The browser tab belongs to the user; nothing to clean up here.
    }
}
