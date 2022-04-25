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
    join(process.resourcesPath, AWS_IAM_AUTHENTICATOR_BASENAME);

export async function writeKubeconfig(clusters: ClusterInfo[]) {
    const path = join(homedir(), ".kube", "config");
    log.info("[writeKubeconfig] Writing %s", path);
    await mkdir(dirname(path), { recursive: true });

    const kubeconfig = clusters
        .map(toKubeconfig)
        .reduce((previous, current) => {
            previous.mergeConfig(current);
            return previous;
        }, new KubeConfig());

    const exported = JSON.parse(kubeconfig.exportConfig());
    const contents = dump(exported);

    await writeFile(path, contents);
}

function toKubeconfig(info: ClusterInfo): KubeConfig {
    const kubeconfig = new KubeConfig();
    const name = `${info.cluster.name}-${info.profile}`;

    kubeconfig.addCluster({
        name,
        server: info.cluster.endpoint!,
        caData: info.cluster.certificateAuthority!.data!,
        skipTLSVerify: false,
    });

    kubeconfig.addUser({
        name,
        exec: {
            apiVersion: "client.authentication.k8s.io/v1alpha1",
            command: AWS_IAM_AUTHENTICATOR,
            args: ["token", "-i", info.cluster.name],
            env: [
                {
                    name: "AWS_PROFILE",
                    value: info.profile,
                },
            ],
        },
    });

    kubeconfig.addContext({
        name,
        user: name,
        cluster: name,
    });

    return kubeconfig;
}
