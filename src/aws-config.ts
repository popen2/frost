import { homedir } from "os";
import { join, dirname } from "path";
import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { createHash } from "crypto";
import ini from "ini";
import log from "electron-log/main";
import { UserConfig } from "./config.js";
import { Profile } from "./profiles.js";

/**
 * Token Frost writes into every profile it owns. Profiles carrying it are
 * rewritten and removed by Frost; everything else in the file is left alone.
 */
const MANAGED_TOKEN = "frost:managed";

const MANAGED_MARKER = `# ${MANAGED_TOKEN} - Frost updates and removes this profile. Delete this line to take it over.`;

const SECTION_HEADER = /^\s*\[([^\]]*)\]/;
const COMMENT_LINE = /^\s*[#;]/;
const PROFILE_SECTION = /^profile\s+(.+)$/;

function awsConfigPath(subpath: string): string {
    return join(homedir(), ".aws", subpath);
}

/**
 * Windows fails the rename outright — EPERM or EBUSY — while another process
 * holds either file open, which for `~/.aws/config` means an AWS CLI command
 * mid-read or an antivirus scanner looking at the file we just wrote. Both
 * clear in milliseconds, so back off briefly rather than failing the refresh.
 */
const RENAME_RETRY_DELAYS_MS = [20, 50, 120, 300];

async function renameWithRetry(from: string, to: string) {
    for (let attempt = 0; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const retriable = code === "EPERM" || code === "EBUSY";
            if (!retriable || attempt >= RENAME_RETRY_DELAYS_MS.length) {
                throw err;
            }
            log.warn(
                "[renameWithRetry] %s renaming to %s, retrying",
                code,
                to
            );
            await new Promise((done) =>
                setTimeout(done, RENAME_RETRY_DELAYS_MS[attempt])
            );
        }
    }
}

async function writeAwsConfigFile(subpath: string, contents: string) {
    const fullPath = awsConfigPath(subpath);
    const tempPath = `${fullPath}.frost-tmp`;
    log.info("[writeAwsConfigFile] Writing %s", fullPath);
    await mkdir(dirname(fullPath), { recursive: true });
    // Write-then-rename so an interrupted run can't leave a truncated file
    // behind - this file also holds profiles Frost doesn't own.
    await writeFile(tempPath, contents);
    await renameWithRetry(tempPath, fullPath);
}

async function readAwsConfigFile(subpath: string): Promise<string> {
    const fullPath = awsConfigPath(subpath);
    try {
        return (await readFile(fullPath)).toString();
    } catch (err) {
        log.debug(
            "[readAwsConfigFile] While trying to read %s: %s",
            fullPath,
            err
        );
        return "";
    }
}

export async function writeAwsConfig(profiles: Profile[]) {
    const existing = await readAwsConfigFile("config");
    const contents = mergeAwsConfig(existing, profiles);

    if (contents === existing) {
        log.info("[writeAwsConfig] %s is up to date", awsConfigPath("config"));
        return;
    }

    await writeAwsConfigFile("config", contents);
}

interface ConfigSection {
    /** Comment lines sitting directly above the section header. */
    leading: string[];
    /** The section header line and everything up to the next section. */
    lines: string[];
    /** Whatever is inside the brackets, e.g. `profile main-admin`. */
    name: string;
    /** Profile name, for `[profile <name>]` sections only. */
    profileName?: string;
    /** Whether this section is marked as owned by Frost. */
    managed: boolean;
}

interface ParsedConfig {
    /** Lines before the first section. */
    preamble: string[];
    sections: ConfigSection[];
    eol: string;
}

/**
 * Merges the generated profiles into an existing `~/.aws/config`:
 *
 * - Sections Frost owns (marked with {@link MANAGED_TOKEN}) are rewritten, and
 *   dropped once the profile is gone from AWS SSO.
 * - Unmarked sections whose name and contents are exactly what Frost would
 *   generate are adopted (marked and kept). This is what stops the first run
 *   after an upgrade from duplicating every profile.
 * - Any other section - `[default]`, hand-written profiles, `[sso-session ...]`
 *   - is preserved verbatim, and a hand-written profile that happens to share a
 *   name with a generated one wins: Frost skips it instead of clobbering it.
 */
export function mergeAwsConfig(existing: string, profiles: Profile[]): string {
    const { preamble, sections, eol } = parseConfig(existing);
    const generated = new Map(
        profiles.map((profile) => [profile.name, profile])
    );
    const handled = new Set<string>();
    const out = [...preamble];

    for (const section of sections) {
        const name = section.profileName;
        const profile = name ? generated.get(name) : undefined;

        if (section.managed) {
            if (!profile || handled.has(name!)) {
                log.info(
                    "[mergeAwsConfig] Removing Frost profile [%s]",
                    section.name
                );
                pushLines(out, section.leading);
                continue;
            }
            pushLines(out, [...section.leading, ...renderProfile(profile)]);
            handled.add(name!);
            continue;
        }

        if (profile && !handled.has(name!)) {
            handled.add(name!);
            if (isAdoptable(section, profile)) {
                log.info(
                    "[mergeAwsConfig] Adopting existing profile [%s]",
                    section.name
                );
                pushLines(out, [...section.leading, ...renderProfile(profile)]);
                continue;
            }
            log.warn(
                "[mergeAwsConfig] Profile [%s] wasn't written by Frost, leaving it untouched",
                section.name
            );
        }

        pushLines(out, [...section.leading, ...section.lines]);
    }

    for (const profile of profiles) {
        if (handled.has(profile.name)) {
            continue;
        }
        log.info("[mergeAwsConfig] Adding profile [profile %s]", profile.name);
        pushLines(out, renderProfile(profile));
    }

    while (out.length && !out[out.length - 1].trim()) {
        out.pop();
    }

    return out.length ? out.join(eol) + eol : "";
}

function parseConfig(contents: string): ParsedConfig {
    const eol = contents.includes("\r\n") ? "\r\n" : "\n";
    const lines = contents.length ? contents.split(/\r?\n/) : [];
    if (lines.length && !lines[lines.length - 1]) {
        lines.pop();
    }

    const preamble: string[] = [];
    const sections: ConfigSection[] = [];
    let current: string[] = preamble;

    for (const line of lines) {
        const match = SECTION_HEADER.exec(line);
        if (!match) {
            current.push(line);
            continue;
        }

        const name = match[1].trim();
        const profileMatch = PROFILE_SECTION.exec(name);
        const section: ConfigSection = {
            leading: takeTrailingComments(current),
            lines: [line],
            name,
            profileName: profileMatch ? profileMatch[1].trim() : undefined,
            managed: false,
        };
        sections.push(section);
        current = section.lines;
    }

    for (const section of sections) {
        // Only `[profile ...]` sections can be Frost's, so a marker that
        // ended up elsewhere (say in `[default]`) can't get anything removed.
        section.managed =
            !!section.profileName && section.lines.some(isManagedMarker);
    }

    return { preamble, sections, eol };
}

/**
 * Removes and returns the trailing run of comment lines, so comments written
 * right above a section header follow that section around (and survive its
 * removal) instead of belonging to the section above them.
 */
function takeTrailingComments(lines: string[]): string[] {
    let start = lines.length;

    for (let i = lines.length - 1; i >= 0; i--) {
        if (isComment(lines[i])) {
            start = i;
        } else if (lines[i].trim()) {
            break;
        }
    }

    return start < lines.length ? lines.splice(start) : [];
}

function isComment(line: string): boolean {
    return COMMENT_LINE.test(line);
}

function isManagedMarker(line: string): boolean {
    return isComment(line) && line.includes(MANAGED_TOKEN);
}

function renderProfile(profile: Profile): string[] {
    const body = ini.stringify(profile.contents, { whitespace: true });
    return [
        `[profile ${profile.name}]`,
        MANAGED_MARKER,
        ...body.split("\n").filter((line) => line.length > 0),
    ];
}

/**
 * Whether an unmarked section holds exactly the profile Frost would write,
 * which means an older version of Frost wrote it and it can be adopted.
 */
function isAdoptable(section: ConfigSection, profile: Profile): boolean {
    const expected = profile.contents as unknown as Record<string, unknown>;
    let parsed: Record<string, unknown>;

    try {
        parsed = ini.parse(section.lines.slice(1).join("\n")) as Record<
            string,
            unknown
        >;
    } catch (err) {
        log.debug(
            "[isAdoptable] Failed parsing [%s]: %s",
            section.name,
            err
        );
        return false;
    }

    const keys = Object.keys(expected);
    return (
        Object.keys(parsed).length === keys.length &&
        keys.every((key) => String(parsed[key]) === String(expected[key]))
    );
}

/** Appends a section, keeping exactly one blank line between sections. */
function pushLines(out: string[], lines: string[]) {
    if (!lines.length) {
        return;
    }
    if (out.length && out[out.length - 1].trim()) {
        out.push("");
    }
    out.push(...lines);
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
