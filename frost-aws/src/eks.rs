//! Best-effort EKS cluster discovery across regions and profiles.
//!
//! For each profile we probe each region's EKS endpoint. Profiles without
//! access simply error and are skipped — exactly as the original did. Unlike
//! the original we iterate a curated region list instead of calling EC2
//! `DescribeRegions`, which keeps `aws-sdk-ec2` (a very large crate) out of the
//! dependency tree. Discovery is still best-effort, so probing a region the
//! account hasn't enabled just yields a skipped error.

use crate::error::{AwsResult, aws};
use aws_config::BehaviorVersion;
use aws_sdk_eks::{Client, config::Region};
use frost_core::{kubeconfig::ClusterInfo, profiles::Profile};
use tracing::debug;

/// Standard commercial AWS regions probed during discovery. Also surfaced
/// to the settings UI so the SSO region dropdown stays in sync with the
/// regions we actually scan.
pub const REGIONS: &[&str] = &[
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "af-south-1",
    "ap-east-1",
    "ap-south-1",
    "ap-south-2",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ca-central-1",
    "eu-central-1",
    "eu-central-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    "il-central-1",
    "me-central-1",
    "me-south-1",
    "sa-east-1",
];

/// Discover every EKS cluster reachable by any of `profiles`.
pub async fn discover(profiles: &[Profile]) -> Vec<ClusterInfo> {
    let mut found = Vec::new();
    for region in REGIONS {
        for profile in profiles {
            let Ok(mut infos) = clusters_in(profile, region).await else {
                debug!(
                    profile = %profile.name,
                    region = %region,
                    "skipping region for profile",
                );
                continue;
            };
            found.append(&mut infos);
        }
    }
    found
}

async fn clusters_in(profile: &Profile, region: &str) -> AwsResult<Vec<ClusterInfo>> {
    let conf = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region.to_owned()))
        .profile_name(&profile.name)
        .load()
        .await;
    let eks = Client::new(&conf);

    let mut names = Vec::new();
    let mut stream = eks.list_clusters().into_paginator().items().send();
    while let Some(item) = stream.next().await {
        names.push(item.map_err(aws)?);
    }

    let mut infos = Vec::with_capacity(names.len());
    for name in names {
        let desc = eks
            .describe_cluster()
            .name(&name)
            .send()
            .await
            .map_err(aws)?;
        let Some(cluster) = desc.cluster() else {
            continue;
        };
        infos.push(ClusterInfo {
            cluster_name: cluster.name().unwrap_or(&name).to_owned(),
            account_name: profile.account_name.clone(),
            role_name: profile.role_name.clone(),
            region: region.to_string(),
            profile_name: profile.name.clone(),
            endpoint: cluster.endpoint().unwrap_or_default().to_owned(),
            ca_data: cluster
                .certificate_authority()
                .and_then(|ca| ca.data())
                .unwrap_or_default()
                .to_owned(),
        });
    }
    Ok(infos)
}
