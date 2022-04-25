import { homedir } from "os";
import { join, dirname } from "path";
import { writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import ini from "ini";
import log from "electron-log";
import { UserConfig } from "./config";
import { Profile } from "./profiles";

async function writeAwsConfigFile(subpath: string, contents: string) {
    const fullPath = join(homedir(), ".aws", subpath);
    log.info("[writeAwsConfigFile] Writing %s", fullPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
}

export async function writeAwsConfig(profiles: Profile[]) {
    const parts = profiles.map((profile) =>
        ini.stringify(profile.contents, {
            section: `profile ${profile.name}`,
            whitespace: true,
        })
    );
    const contents = parts.join("\n");
    await writeAwsConfigFile("config", contents);
}

export async function writeSsoConfig(
    userConfig: UserConfig,
    accessToken: string,
    expiresAt: string
) {
    const hash = createHash("sha1");
    hash.update(userConfig.startUrl!);
    const filename = `${hash.digest("hex")}.json`;

    const contents = {
        startUrl: userConfig.startUrl,
        region: userConfig.region,
        accessToken,
        expiresAt,
    };

    await writeAwsConfigFile(
        join("sso", "cache", filename),
        JSON.stringify(contents)
    );
}
