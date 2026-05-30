//! Portable, GUI-agnostic core of Frost.
//!
//! Everything here is pure logic + data shapes: profile-name generation,
//! `~/.aws/config` and SSO-cache rendering, and `~/.kube/config` building.
//! It has no dependency on Tauri, the AWS SDK, or the embedded browser, so it
//! compiles fast and is exercised entirely by unit tests. The shell and the
//! AWS/browser adapter crates build on top of it.

pub mod aws_config;
pub mod config;
pub mod kubeconfig;
pub mod profiles;
