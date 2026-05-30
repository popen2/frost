//! Integration tests for kubeconfig context-name selection and merging.

use frost_core::kubeconfig::{
    ClusterInfo, KubeConfig, NamePattern, choose_name_pattern, merge_kubeconfig,
};

fn info(cluster: &str, account: &str, role: &str, region: &str) -> ClusterInfo {
    ClusterInfo {
        cluster_name: cluster.into(),
        account_name: account.into(),
        role_name: role.into(),
        region: region.into(),
        profile_name: format!("{account}-{role}"),
        endpoint: "https://eks.example".into(),
        ca_data: "Y2E=".into(),
    }
}

#[test]
fn single_cluster_uses_bare_name() {
    let infos = vec![info("prod", "acme", "admin", "us-east-1")];
    assert_eq!(choose_name_pattern(&infos), NamePattern::ClusterOnly);
    assert_eq!(choose_name_pattern(&infos).format(&infos[0]), "prod");
}

#[test]
fn same_role_different_region_appends_region() {
    let infos = vec![
        info("prod", "acme", "admin", "us-east-1"),
        info("stage", "acme", "admin", "eu-west-1"),
    ];
    assert_eq!(choose_name_pattern(&infos), NamePattern::ClusterRegion);
    assert_eq!(
        choose_name_pattern(&infos).format(&infos[0]),
        "prod:us-east-1"
    );
}

#[test]
fn same_region_different_role_appends_role() {
    let infos = vec![
        info("prod", "acme", "admin", "us-east-1"),
        info("stage", "acme", "poweruser", "us-east-1"),
    ];
    assert_eq!(choose_name_pattern(&infos), NamePattern::ClusterRole);
    assert_eq!(
        choose_name_pattern(&infos).format(&infos[1]),
        "stage:poweruser"
    );
}

#[test]
fn differing_role_and_region_appends_both() {
    let infos = vec![
        info("prod", "acme", "admin", "us-east-1"),
        info("stage", "acme", "poweruser", "eu-west-1"),
    ];
    assert_eq!(choose_name_pattern(&infos), NamePattern::ClusterRegionRole);
    assert_eq!(
        choose_name_pattern(&infos).format(&infos[0]),
        "prod:us-east-1:admin"
    );
}

#[test]
fn colliding_cluster_names_use_full_pattern() {
    // Same cluster name reached via two accounts must not collide.
    let infos = vec![
        info("shared", "acme", "admin", "us-east-1"),
        info("shared", "beta", "admin", "us-east-1"),
    ];
    assert_eq!(choose_name_pattern(&infos), NamePattern::Full);
    assert_eq!(
        choose_name_pattern(&infos).format(&infos[0]),
        "shared:acme:us-east-1:admin"
    );
    assert_eq!(
        choose_name_pattern(&infos).format(&infos[1]),
        "shared:beta:us-east-1:admin"
    );
}

#[test]
fn merge_into_empty_produces_valid_config() {
    let infos = vec![info("prod", "acme", "admin", "us-east-1")];
    let yaml = merge_kubeconfig(None, &infos, "/path/aws-iam-authenticator").unwrap();
    let parsed: KubeConfig = serde_yaml::from_str(&yaml).unwrap();
    assert_eq!(parsed.api_version, "v1");
    assert_eq!(parsed.kind, "Config");
    assert_eq!(parsed.clusters.len(), 1);
    assert_eq!(parsed.clusters[0].name, "prod");
    assert_eq!(parsed.users[0].user.exec.args, vec!["token", "-i", "prod"]);
    assert_eq!(parsed.users[0].user.exec.env[0].value, "acme-admin");
    assert_eq!(parsed.contexts[0].context.cluster, "prod");
}

#[test]
fn merge_replaces_same_name_and_keeps_others() {
    let existing = "\
apiVersion: v1
kind: Config
clusters:
- name: other
  cluster:
    server: https://other
    certificate-authority-data: eC0=
- name: prod
  cluster:
    server: https://stale
    certificate-authority-data: c3RhbGU=
users: []
contexts: []
";
    let infos = vec![info("prod", "acme", "admin", "us-east-1")];
    let yaml = merge_kubeconfig(Some(existing), &infos, "/auth").unwrap();
    let parsed: KubeConfig = serde_yaml::from_str(&yaml).unwrap();

    let names: Vec<&str> = parsed.clusters.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"other"));
    assert!(names.contains(&"prod"));
    assert_eq!(parsed.clusters.len(), 2);
    let prod = parsed.clusters.iter().find(|c| c.name == "prod").unwrap();
    assert_eq!(prod.cluster.server, "https://eks.example");
}
