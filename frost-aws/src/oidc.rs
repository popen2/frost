//! AWS SSO OIDC client registration and the device-authorization login flow.
//!
//! These operations are unauthenticated (the client id/secret and the bearer
//! token do the work), so the clients are built without a credentials provider.

use crate::{
    browser::LoginBrowser,
    error::{AwsResult, Error, aws},
};
use aws_sdk_ssooidc::{
    Client,
    config::{BehaviorVersion, Region},
    operation::create_token::CreateTokenError,
};
use chrono::{DateTime, Utc};
use frost_core::config::RegisteredClient;
use std::time::Duration;

const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_SECS: i32 = 5;

/// An access token obtained from AWS SSO.
#[derive(Debug, Clone)]
pub struct Token {
    pub access_token: String,
    pub expires_at: DateTime<Utc>,
}

fn client(region: &str) -> Client {
    let conf = aws_sdk_ssooidc::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(region.to_owned()))
        .build();
    Client::from_conf(conf)
}

/// Register a new public OIDC client with AWS SSO.
pub async fn register_client(region: &str, client_name: &str) -> AwsResult<RegisteredClient> {
    let out = client(region)
        .register_client()
        .client_name(client_name)
        .client_type("public")
        .send()
        .await
        .map_err(aws)?;

    Ok(RegisteredClient {
        client_name: client_name.to_owned(),
        client_id: out
            .client_id()
            .ok_or(Error::Unexpected("missing client id"))?
            .to_owned(),
        client_secret: out
            .client_secret()
            .ok_or(Error::Unexpected("missing client secret"))?
            .to_owned(),
        issued_at: out.client_id_issued_at(),
        expires_at: out.client_secret_expires_at(),
    })
}

/// Run the device-authorization flow: open the verification URL in `browser`
/// and poll until the user finishes signing in (or it times out).
pub async fn login(
    region: &str,
    registered: &RegisteredClient,
    start_url: &str,
    browser: &impl LoginBrowser,
) -> AwsResult<Token> {
    let oidc = client(region);

    let auth = oidc
        .start_device_authorization()
        .client_id(&registered.client_id)
        .client_secret(&registered.client_secret)
        .start_url(start_url)
        .send()
        .await
        .map_err(aws)?;

    let verification = auth
        .verification_uri_complete()
        .ok_or(Error::Unexpected("missing verification uri"))?
        .to_owned();
    let device_code = auth
        .device_code()
        .ok_or(Error::Unexpected("missing device code"))?
        .to_owned();

    let mut interval = auth.interval();
    if interval <= 0 {
        interval = DEFAULT_POLL_SECS;
    }
    let deadline = Utc::now() + chrono::Duration::seconds(auth.expires_in().max(0) as i64);

    browser.open(&verification).await?;

    let result = poll_for_token(&oidc, registered, &device_code, &mut interval, deadline).await;
    browser.close().await;
    result
}

async fn poll_for_token(
    oidc: &Client,
    registered: &RegisteredClient,
    device_code: &str,
    interval: &mut i32,
    deadline: DateTime<Utc>,
) -> AwsResult<Token> {
    loop {
        if Utc::now() >= deadline {
            return Err(Error::LoginTimedOut);
        }
        tokio::time::sleep(Duration::from_secs((*interval).max(1) as u64)).await;

        match oidc
            .create_token()
            .client_id(&registered.client_id)
            .client_secret(&registered.client_secret)
            .grant_type(DEVICE_GRANT)
            .device_code(device_code)
            .send()
            .await
        {
            Ok(tok) => {
                let access_token = tok
                    .access_token()
                    .ok_or(Error::Unexpected("missing access token"))?
                    .to_owned();
                let expires_at = Utc::now() + chrono::Duration::seconds(tok.expires_in() as i64);
                return Ok(Token {
                    access_token,
                    expires_at,
                });
            }
            Err(err) => match err.into_service_error() {
                CreateTokenError::AuthorizationPendingException(_) => continue,
                CreateTokenError::SlowDownException(_) => {
                    *interval += DEFAULT_POLL_SECS;
                    continue;
                }
                other => return Err(aws(other)),
            },
        }
    }
}
