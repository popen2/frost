import { homedir } from "os";
import { join, dirname } from "path";
import { writeFile, mkdir } from "fs/promises";
import log from "electron-log";
import { ClusterInfo } from "./aws-eks";
import { KubeConfig } from "@kubernetes/client-node";
import { dump } from "js-yaml";

const AWS_IAM_AUTHENTICATOR_BASENAME =
    process.platform === "win32"
        ? "aws-iam-authenticator.exe"
        : "aws-iam-authenticator";

const AWS_IAM_AUTHENTICATOR =
    process.env["AWS_IAM_AUTHENTICATOR_PATH"] ||
    join(process.resourcesPath, "app", AWS_IAM_AUTHENTICATOR_BASENAME);

type NamePattern = (info: ClusterInfo) => string;

export async function writeKubeconfig(clusters: ClusterInfo[]) {
    const path = join(homedir(), ".kube", "config");
    log.info("[writeKubeconfig] Writing %s", path);
    await mkdir(dirname(path), { recursive: true });

    const namePattern = getNamePattern(clusters);

    const kubeconfig = clusters
        .map((cluster) => toKubeconfig(cluster, namePattern))
        .reduce((previous, current) => {
            previous.mergeConfig(current);
            return previous;
        }, new KubeConfig());

    const exported = JSON.parse(kubeconfig.exportConfig());
    const contents = dump(exported);

    await writeFile(path, contents);
}

function getNamePattern(infos: ClusterInfo[]): NamePattern {
    const clusterNames = infos.map((info) => info.cluster.name);
    const clusterIds = infos.map(
        (info) =>
            `${info.cluster.name}:${info.profile.accountName}:${info.region.RegionName}`
    );
    const roleNames = infos.map((info) => info.profile.roleName);
    const regionNames = infos.map((info) => info.region.RegionName);

    const uniqueClusters = clusterNames.length === clusterIds.length;
    const sameRoleName = new Set(roleNames).size === 1;
    const sameRegion = new Set(regionNames).size === 1;

    if (uniqueClusters) {
        if (sameRoleName && sameRegion) {
            return (info: ClusterInfo) => `${info.cluster.name}`;
        }
        if (sameRoleName) {
            return (info: ClusterInfo) =>
                `${info.cluster.name}:${info.region.RegionName}`;
        }
        if (sameRegion) {
            return (info: ClusterInfo) =>
                `${info.cluster.name}:${info.profile.roleName}`;
        }
        return (info: ClusterInfo) =>
            `${info.cluster.name}:${info.region.RegionName}:${info.profile.roleName}`;
    }

    return (info: ClusterInfo) =>
        `${info.cluster.name}:${info.profile.accountName}:${info.region.RegionName}:${info.profile.roleName}`;
}

function toKubeconfig(info: ClusterInfo, getName: NamePattern): KubeConfig {
    const kubeconfig = new KubeConfig();
    const name = getName(info);

    kubeconfig.addCluster({
        name,
        server: info.cluster.endpoint!,
        caData: info.cluster.certificateAuthority!.data!,
        skipTLSVerify: false,
    });

    kubeconfig.addUser({
        name,
        exec: {
            apiVersion: "client.authentication.k8s.io/v1",
            command: AWS_IAM_AUTHENTICATOR,
            args: ["token", "-i", info.cluster.name],
            env: [
                {
                    name: "AWS_PROFILE",
                    value: info.profile.name,
                },
            ],
            interactiveMode: "Never",
        },
    });

    kubeconfig.addContext({
        name,
        user: name,
        cluster: name,
    });

    return kubeconfig;
}
