use std::fmt::Display;

/// Result alias for fallible operations in this crate.
///
/// Named `AwsResult` rather than `Result` so importing it doesn't shadow the
/// `std::result::Result` brought in by the prelude.
pub type AwsResult<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("AWS error: {0}")]
    Aws(String),

    #[error("not configured: {0}")]
    NotConfigured(&'static str),

    #[error("login window was closed before completing")]
    LoginAborted,

    #[error("login timed out")]
    LoginTimedOut,

    #[error("login browser: {0}")]
    Browser(String),

    #[error("unexpected response from AWS: {0}")]
    Unexpected(&'static str),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Yaml(#[from] serde_yaml::Error),
}

/// Collapse any AWS SDK error into a stringly-typed [`Error::Aws`].
pub fn aws<E: Display>(err: E) -> Error {
    Error::Aws(err.to_string())
}
