import { EC2, EKS, SsoCredentials } from "aws-sdk";
import { Region, RegionList } from "aws-sdk/clients/ec2";
import { Cluster } from "aws-sdk/clients/eks";
import log from "electron-log";
import { config } from "./config";
import { writeKubeconfig } from "./kubeconfig";

export async function updateKubeConfig(profiles: string[]) {
    if (profiles.length === 0) {
        return;
    }

    process.env["AWS_SDK_LOAD_CONFIG"] = "1";

    const regions = await getRegions(profiles[0]);
    const clusters = (
        await Promise.all(
            regions
                .map((region) =>
                    profiles.map((profile) => getClusters(profile, region))
                )
                .flat()
        )
    ).flat();

    config.set(
        "clusters",
        clusters.map((cluster) => ({
            name: cluster.cluster.name,
            profile: cluster.profile,
            region: cluster.region.RegionName,
        }))
    );

    await writeKubeconfig(clusters);
}

async function getRegions(profile: string): Promise<RegionList> {
    log.info("[getRegions] Getting regions");
    const ec2 = new EC2({
        region: "us-east-1",
        credentials: new SsoCredentials({ profile }),
    });
    const res = await ec2.describeRegions().promise();
    const regions = res.Regions!;
    log.debug("[getRegions] Regions: %s", regions);
    return regions;
}

export interface ClusterInfo {
    cluster: Cluster;
    profile: string;
    region: Region;
}

async function getClusters(
    profile: string,
    region: Region
): Promise<ClusterInfo[]> {
    log.info("[getClusters] Getting clusters for %s", region);
    const regionName = region.RegionName;
    const eks = new EKS({
        region: regionName,
        credentials: new SsoCredentials({ profile }),
    });

    try {
        let nextToken;
        const clusterNames: string[] = [];
        do {
            const res = await eks.listClusters({ nextToken }).promise();
            for (const cluster of res.clusters!) {
                log.info(
                    "[getClusters] Found cluster: profile=%s region=%s cluster=%s",
                    profile,
                    regionName,
                    cluster
                );
                clusterNames.push(cluster);
            }
        } while (nextToken);

        const clusterResponses = await Promise.all(
            clusterNames.map((name) =>
                eks
                    .describeCluster({
                        name,
                    })
                    .promise()
            )
        );

        return clusterResponses.map((res) => ({
            cluster: res.cluster!,
            profile,
            region,
        }));
    } catch (err) {
        log.warn(
            "[getClusters] Failed for profile=%s region=%s: %s",
            profile,
            region,
            err
        );
    }
    return [];
}
