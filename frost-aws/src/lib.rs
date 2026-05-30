//! AWS adapter layer for Frost.
//!
//! Wraps `aws-sdk-rust` to implement the SSO OIDC login flow, account/role
//! enumeration, and EKS discovery, then drives `frost-core` to render the
//! resulting `~/.aws` and `~/.kube` files. The login browser is abstracted
//! behind [`browser::LoginBrowser`] so the shell layer supplies the actual
//! window without this crate depending on it.

pub mod browser;
pub mod eks;
pub mod error;
pub mod fs;
pub mod oidc;
pub mod refresh;
pub mod sso;
