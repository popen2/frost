import {
    EC2Client,
    DescribeRegionsCommand,
    type Region,
} from "@aws-sdk/client-ec2";
import {
    EKSClient,
    ListClustersCommand,
    DescribeClusterCommand,
    type Cluster,
} from "@aws-sdk/client-eks";
import { fromSSO } from "@aws-sdk/credential-providers";
import log from "electron-log/main";
import { config } from "./config.js";
import { Profile } from "./profiles.js";
import { writeKubeconfig } from "./kubeconfig.js";

export async function updateKubeConfig(profiles: Profile[]) {
    if (profiles.length === 0) {
        return;
    }

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
            profile: cluster.profile.name,
            region: cluster.region.RegionName,
        }))
    );

    await writeKubeconfig(clusters);
}

async function getRegions(profile: Profile): Promise<Region[]> {
    log.info("[getRegions] Getting regions");
    const ec2 = new EC2Client({
        region: "us-east-1",
        credentials: fromSSO({ profile: profile.name }),
    });
    const res = await ec2.send(new DescribeRegionsCommand({}));
    const regions = res.Regions!;
    log.debug("[getRegions] Regions: %s", regions);
    return regions;
}

export interface ClusterInfo {
    cluster: Cluster;
    profile: Profile;
    region: Region;
}

async function getClusters(
    profile: Profile,
    region: Region
): Promise<ClusterInfo[]> {
    log.info("[getClusters] Getting clusters for %s", region);
    const regionName = region.RegionName;
    const eks = new EKSClient({
        region: regionName,
        credentials: fromSSO({ profile: profile.name }),
    });

    try {
        let nextToken: string | undefined;
        const clusterNames: string[] = [];
        do {
            const res = await eks.send(new ListClustersCommand({ nextToken }));
            for (const cluster of res.clusters!) {
                log.info(
                    "[getClusters] Found cluster: profile=%s region=%s cluster=%s",
                    profile,
                    regionName,
                    cluster
                );
                clusterNames.push(cluster);
            }
            nextToken = res.nextToken;
        } while (nextToken);

        const clusterResponses = await Promise.all(
            clusterNames.map((name) =>
                eks.send(new DescribeClusterCommand({ name }))
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
