use crate::error::AwsResult;

/// The login surface Frost drives during an SSO sign-in.
///
/// AWS SSO uses a device-authorization flow: we open a verification URL and
/// poll for a token while the user authenticates (potentially with a YubiKey).
/// Because `WKWebView` can't do FIDO2 security keys, the real implementation
/// in the shell opens the user's default browser; this trait keeps
/// `frost-aws` decoupled from the GUI layer and unit-testable.
///
/// `async fn` in trait without an explicit `Send` bound is fine here because
/// the only impls live in this workspace and the concrete types we use
/// (`SystemLoginBrowser` in `src-tauri`) yield `Send` futures.
#[allow(async_fn_in_trait)]
pub trait LoginBrowser: Send + Sync {
    /// Open `url` in the controllable browser and show it to the user.
    async fn open(&self, url: &str) -> AwsResult<()>;

    /// Close the login window (called on success, timeout, or error).
    async fn close(&self);
}
