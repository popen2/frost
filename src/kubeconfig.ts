import { homedir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { writeFilePreservingMode } from "./atomic-write.js";
import log from "electron-log/main";
import { ClusterInfo } from "./aws-eks.js";
import * as yaml from "js-yaml";

const AWS_IAM_AUTHENTICATOR_BASENAME =
    process.platform === "win32"
        ? "aws-iam-authenticator.exe"
        : "aws-iam-authenticator";

/**
 * Locates the bundled authenticator that `extraResource` in forge.config.js
 * copies into the package.
 *
 * It ends up in two places: `resources/` from `extraResource` itself, and
 * `resources/app/` because the packager also copies the project directory
 * wholesale. Older builds only had the second one. The path is written into
 * the user's kubeconfig, so guessing wrong leaves an entry that fails only
 * later, when kubectl tries to run it — probe for it instead.
 */
function findAwsIamAuthenticator(): string {
    const override = process.env["AWS_IAM_AUTHENTICATOR_PATH"];
    if (override) {
        return override;
    }

    const candidates = [
        join(process.resourcesPath, AWS_IAM_AUTHENTICATOR_BASENAME),
        join(process.resourcesPath, "app", AWS_IAM_AUTHENTICATOR_BASENAME),
    ];

    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
        log.warn(
            "[findAwsIamAuthenticator] Not found in %s, falling back to %s",
            candidates.join(", "),
            candidates[0]
        );
    }
    return found || candidates[0];
}

const AWS_IAM_AUTHENTICATOR = findAwsIamAuthenticator();

type NamePattern = (info: ClusterInfo) => string;

/** The per-entry key that holds the body, one per kubeconfig list. */
type Section = "cluster" | "user" | "context";

/** One entry of `clusters`, `users` or `contexts`. */
interface NamedEntry {
    name?: unknown;
    [key: string]: unknown;
}

/**
 * A kubeconfig as it is on disk. Only the three lists are spelled out because
 * they are the only thing Frost writes; `current-context`, `preferences`,
 * per-entry `extensions` and whatever kubectl grows next ride along in the
 * index signature and are written back untouched.
 */
interface KubeconfigDocument {
    clusters?: NamedEntry[];
    users?: NamedEntry[];
    contexts?: NamedEntry[];
    [key: string]: unknown;
}

function kubeconfigPath(): string {
    return join(homedir(), ".kube", "config");
}

async function readKubeconfigFile(fullPath: string): Promise<string> {
    try {
        return (await readFile(fullPath)).toString();
    } catch (err) {
        log.debug(
            "[readKubeconfigFile] While trying to read %s: %s",
            fullPath,
            err
        );
        return "";
    }
}

export async function writeKubeconfig(clusters: ClusterInfo[]) {
    const fullPath = kubeconfigPath();
    const existing = await readKubeconfigFile(fullPath);

    let contents: string;
    try {
        contents = mergeKubeconfig(existing, clusters);
    } catch (err) {
        // Most of this file is the user's - their own clusters, their
        // current-context. One we cannot parse is one we cannot merge into,
        // and writing our entries on their own would throw the rest away.
        log.error(
            "[writeKubeconfig] Leaving %s alone, cannot parse it: %s",
            fullPath,
            err
        );
        return;
    }

    if (contents === existing) {
        log.info("[writeKubeconfig] %s is up to date", fullPath);
        return;
    }

    log.info("[writeKubeconfig] Writing %s", fullPath);
    // Holds the user's own clusters as well as ours, so an interrupted run
    // must not truncate it and their permissions are theirs to keep.
    await writeFilePreservingMode(fullPath, contents);
}

/**
 * Merges the discovered clusters into an existing kubeconfig.
 *
 * The parsed document is edited in place rather than rebuilt from a model of a
 * kubeconfig. A model only carries the fields it knows about, so a round trip
 * through one drops the rest - `preferences`, `extensions`, impersonation keys
 * - and a single entry it refuses to parse costs the user every context and
 * user in the file. `kubectl config set-context x --namespace=y` writes such
 * an entry: a context with no cluster.
 *
 * Pure and importable, so it can be exercised without an Electron app.
 */
export function mergeKubeconfig(
    existing: string,
    infos: ClusterInfo[]
): string {
    const document = parseKubeconfig(existing);
    const getName = getNamePattern(infos);

    for (const info of infos) {
        const name = getName(info);

        document.clusters = upsert(document.clusters, name, "cluster", {
            server: info.cluster.endpoint!,
            "certificate-authority-data":
                info.cluster.certificateAuthority!.data!,
        });

        document.users = upsert(document.users, name, "user", {
            exec: {
                apiVersion: "client.authentication.k8s.io/v1",
                command: AWS_IAM_AUTHENTICATOR,
                args: ["token", "-i", info.cluster.name!],
                env: [{ name: "AWS_PROFILE", value: info.profile.name }],
                interactiveMode: "Never",
            },
        });

        document.contexts = upsert(document.contexts, name, "context", {
            cluster: name,
            user: name,
        });
    }

    // Every value on one line. Folding a base64 certificate or an application
    // path across lines is legal YAML and kubectl reads it back, but it leaves
    // a file unlike what `aws eks update-kubeconfig` writes and unreadable in
    // a diff.
    return yaml.dump(document, { lineWidth: -1 });
}

function parseKubeconfig(existing: string): KubeconfigDocument {
    if (existing.trim() === "") {
        return { apiVersion: "v1", kind: "Config", preferences: {} };
    }

    const document = yaml.load(existing);
    if (
        typeof document !== "object" ||
        document === null ||
        Array.isArray(document)
    ) {
        throw new Error("kubeconfig is not a YAML mapping");
    }
    return document as KubeconfigDocument;
}

/**
 * Writes one `{ name, <section>: {...} }` entry, replacing the same-named one
 * if it is already there.
 *
 * That replacement merges, and keeps the entry where it was: Frost owns the
 * keys it writes and nothing else, so a namespace the user set on one of these
 * contexts, or a `proxy-url` on the cluster, survives the next refresh.
 */
function upsert(
    entries: NamedEntry[] | undefined,
    name: string,
    section: Section,
    body: Record<string, unknown>
): NamedEntry[] {
    const list = Array.isArray(entries) ? entries : [];
    const index = list.findIndex((entry) => entry?.name === name);

    if (index < 0) {
        return [...list, { name, [section]: body }];
    }

    const previous = list[index][section];
    const merged =
        typeof previous === "object" && previous !== null
            ? { ...previous, ...body }
            : body;

    return list.map((entry, at) =>
        at === index ? { ...entry, name, [section]: merged } : entry
    );
}

function getNamePattern(infos: ClusterInfo[]): NamePattern {
    const clusterNames = infos.map((info) => info.cluster.name);
    const clusterIds = infos.map(
        (info) =>
            `${info.cluster.name}:${info.profile.accountName}:${info.region.RegionName}`
    );
    const roleNames = infos.map((info) => info.profile.roleName);
    const regionNames = infos.map((info) => info.region.RegionName);

    // Whether the bare name tells two *different* clusters apart. One cluster
    // reached through several profiles is one id and one name; two clusters
    // that happen to share a name are two ids and one name, and every pattern
    // below would then hand them the same entry and lose one of them.
    const uniqueClusters =
        new Set(clusterNames).size === new Set(clusterIds).size;
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
