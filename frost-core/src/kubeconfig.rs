//! EKS cluster -> `~/.kube/config` generation.
//!
//! Ported from `src/kubeconfig.ts`. Two responsibilities:
//!   1. Choose the least-verbose context name that still disambiguates every
//!      discovered cluster (`choose_name_pattern`).
//!   2. Merge the generated entries into any existing kubeconfig, replacing
//!      entries with the same name and leaving everything else untouched.

use serde::{Deserialize, Serialize};

/// A discovered EKS cluster plus the profile/region it was found through.
#[derive(Debug, Clone)]
pub struct ClusterInfo {
    /// The EKS cluster name (used as the `-i` argument to the authenticator).
    pub cluster_name: String,
    /// Short account name (from profile generation).
    pub account_name: String,
    /// Short role name (from profile generation).
    pub role_name: String,
    /// AWS region the cluster lives in.
    pub region: String,
    /// Full AWS profile name, used as `AWS_PROFILE` for the authenticator.
    pub profile_name: String,
    /// API server endpoint.
    pub endpoint: String,
    /// Base64 cluster CA data.
    pub ca_data: String,
}

/// Which fields are appended to a cluster name to keep entries unique.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamePattern {
    ClusterOnly,
    ClusterRegion,
    ClusterRole,
    ClusterRegionRole,
    Full,
}

impl NamePattern {
    pub fn format(&self, info: &ClusterInfo) -> String {
        let c = &info.cluster_name;
        match self {
            NamePattern::ClusterOnly => c.clone(),
            NamePattern::ClusterRegion => format!("{c}:{}", info.region),
            NamePattern::ClusterRole => format!("{c}:{}", info.role_name),
            NamePattern::ClusterRegionRole => {
                format!("{c}:{}:{}", info.region, info.role_name)
            }
            NamePattern::Full => format!(
                "{c}:{}:{}:{}",
                info.account_name, info.region, info.role_name
            ),
        }
    }
}

/// Pick the simplest naming scheme that keeps every entry's name unique.
///
/// Note: the original TypeScript compared `clusterNames.length` to
/// `clusterIds.length`, which are always equal — so the `Full` fallback was
/// dead code and colliding cluster names could overwrite each other. Here we
/// fix that by testing whether the cluster names are actually unique.
pub fn choose_name_pattern(infos: &[ClusterInfo]) -> NamePattern {
    let cluster_names: Vec<&str> = infos.iter().map(|i| i.cluster_name.as_str()).collect();
    let unique_clusters = unique(cluster_names.iter().copied());
    let same_role = infos
        .iter()
        .map(|i| i.role_name.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len()
        == 1;
    let same_region = infos
        .iter()
        .map(|i| i.region.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len()
        == 1;

    if unique_clusters {
        match (same_role, same_region) {
            (true, true) => NamePattern::ClusterOnly,
            (true, false) => NamePattern::ClusterRegion,
            (false, true) => NamePattern::ClusterRole,
            (false, false) => NamePattern::ClusterRegionRole,
        }
    } else {
        NamePattern::Full
    }
}

fn unique<'a>(items: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = std::collections::HashSet::new();
    items.into_iter().all(|i| seen.insert(i))
}

// --- kubeconfig document model -------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KubeConfig {
    #[serde(rename = "apiVersion", default = "api_version")]
    pub api_version: String,
    #[serde(default = "kind")]
    pub kind: String,
    #[serde(default)]
    pub clusters: Vec<NamedCluster>,
    #[serde(default)]
    pub users: Vec<NamedUser>,
    #[serde(default)]
    pub contexts: Vec<NamedContext>,
    #[serde(
        rename = "current-context",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub current_context: Option<String>,
    #[serde(flatten, default)]
    pub extra: serde_yaml::Mapping,
}

fn api_version() -> String {
    "v1".to_owned()
}
fn kind() -> String {
    "Config".to_owned()
}

impl Default for KubeConfig {
    fn default() -> Self {
        KubeConfig {
            api_version: api_version(),
            kind: kind(),
            clusters: Vec::new(),
            users: Vec::new(),
            contexts: Vec::new(),
            current_context: None,
            extra: serde_yaml::Mapping::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedCluster {
    pub name: String,
    pub cluster: ClusterSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterSpec {
    pub server: String,
    #[serde(rename = "certificate-authority-data")]
    pub certificate_authority_data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedUser {
    pub name: String,
    pub user: UserSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSpec {
    pub exec: ExecConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecConfig {
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<EnvVar>,
    #[serde(rename = "interactiveMode")]
    pub interactive_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NamedContext {
    pub name: String,
    pub context: ContextSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSpec {
    pub cluster: String,
    pub user: String,
}

/// Merge discovered clusters into an existing kubeconfig YAML body.
///
/// `existing` is the current `~/.kube/config` contents (if any). Entries whose
/// names collide with generated ones are replaced; all other entries and
/// top-level keys are preserved. `authenticator` is the absolute path to the
/// bundled `aws-iam-authenticator` binary.
pub fn merge_kubeconfig(
    existing: Option<&str>,
    infos: &[ClusterInfo],
    authenticator: &str,
) -> Result<String, serde_yaml::Error> {
    let mut config: KubeConfig = match existing {
        Some(text) if !text.trim().is_empty() => serde_yaml::from_str(text)?,
        _ => KubeConfig::default(),
    };

    let pattern = choose_name_pattern(infos);
    for info in infos {
        let name = pattern.format(info);

        config.clusters.retain(|c| c.name != name);
        config.clusters.push(NamedCluster {
            name: name.clone(),
            cluster: ClusterSpec {
                server: info.endpoint.clone(),
                certificate_authority_data: info.ca_data.clone(),
            },
        });

        config.users.retain(|u| u.name != name);
        config.users.push(NamedUser {
            name: name.clone(),
            user: UserSpec {
                exec: ExecConfig {
                    api_version: "client.authentication.k8s.io/v1".to_owned(),
                    command: authenticator.to_owned(),
                    args: vec!["token".into(), "-i".into(), info.cluster_name.clone()],
                    env: vec![EnvVar {
                        name: "AWS_PROFILE".into(),
                        value: info.profile_name.clone(),
                    }],
                    interactive_mode: "Never".to_owned(),
                },
            },
        });

        config.contexts.retain(|c| c.name != name);
        config.contexts.push(NamedContext {
            name: name.clone(),
            context: ContextSpec {
                cluster: name.clone(),
                user: name.clone(),
            },
        });
    }

    serde_yaml::to_string(&config)
}
