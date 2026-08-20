import * as path from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";
import { app } from "electron";
import log from "electron-log/main";
import { config, DEFAULT_BEHAVIOR, type BehaviorConfig } from "./config.js";

/** One log file per local day: `main-2026-08-17.log`. */
const DATED_LOG = /^main-(\d{4}-\d{2}-\d{2})\.log$/;

/** What electron-log wrote before the move to dated files. */
const LEGACY_LOGS = ["main.log", "main.old.log"];

/** Only `resolvePathFn` is told where `libraryDefaultDir` is, so catch it there. */
let logDirectory: string | null = null;

/**
 * Local, not `toISOString()`: a UTC date rolls the file over mid-afternoon far
 * enough from Greenwich, which defeats asking a user for "today's log".
 */
function localDate(when: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

export function configureLogging() {
    const file = log.transports.file;

    // Below electron-log's `silly` default, but keeping the poll-by-poll
    // detail that makes a failed login diagnosable. Nothing secret is logged
    // at either level - see the redaction in aws-sso.ts.
    file.level = "debug";

    // Otherwise we get size rotation too, and a `main-<date>.old.log`.
    file.maxSize = 0;

    // Carries the account and role inventory, so same treatment as the config
    // file rather than electron-log's world-readable 0o666 default.
    file.writeOptions = { flag: "a", mode: 0o600, encoding: "utf8" };

    file.resolvePathFn = (variables) => {
        logDirectory = variables.libraryDefaultDir;
        return path.join(variables.libraryDefaultDir, `main-${localDate()}.log`);
    };
}

/** Version, platform and Electron build - the first thing any report needs. */
export function logStartupBanner() {
    log.info(
        "[main] Frost %s | electron %s | node %s | %s/%s | packaged=%s",
        app.getVersion(),
        process.versions.electron,
        process.versions.node,
        process.platform,
        process.arch,
        app.isPackaged
    );
}

function retentionDays(): number {
    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;
    return (
        behavior.historyRetentionDays ?? DEFAULT_BEHAVIOR.historyRetentionDays
    );
}

/**
 * Deletes log files past the retention period chosen in Privacy - the same
 * setting as the run history, so the log and the history describing it age out
 * together. Call it wherever `pruneHistory()` is called.
 *
 * Legacy `main.log`/`main.old.log` go by mtime, and matter most: they predate
 * the fix that stopped writing device codes to the log.
 */
export async function sweepOldLogs(): Promise<void> {
    if (!logDirectory) {
        return;
    }

    const cutoffTime = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;
    const cutoffDate = localDate(new Date(cutoffTime));
    const current = `main-${localDate()}.log`;

    let entries: string[];
    try {
        entries = await readdir(logDirectory);
    } catch (err) {
        log.debug("[sweepOldLogs] Could not read %s: %s", logDirectory, err);
        return;
    }

    for (const entry of entries) {
        if (entry === current) {
            continue;
        }

        const fullPath = path.join(logDirectory, entry);
        const dated = DATED_LOG.exec(entry);

        try {
            if (dated) {
                // String compare is safe: the format is zero-padded and fixed
                // width, so lexical order is chronological order.
                if (dated[1] >= cutoffDate) {
                    continue;
                }
            } else if (LEGACY_LOGS.includes(entry)) {
                if ((await stat(fullPath)).mtimeMs >= cutoffTime) {
                    continue;
                }
            } else {
                continue;
            }

            await unlink(fullPath);
            log.info("[sweepOldLogs] Removed %s", entry);
        } catch (err) {
            log.debug("[sweepOldLogs] Could not remove %s: %s", entry, err);
        }
    }
}

/**
 * Renders an error with the parts that make it actionable.
 *
 * `${err}` gives you `"Error: message"` and throws away everything the AWS SDK
 * attaches - the exception name we branch on, the HTTP status, and the request
 * id that AWS support asks for first.
 */
export function describeError(err: unknown): string {
    if (!(err instanceof Error)) {
        return String(err);
    }

    const parts = [`${err.name}: ${err.message}`];
    const service = err as {
        $fault?: string;
        $metadata?: { httpStatusCode?: number; requestId?: string };
    };

    if (service.$fault) {
        parts.push(`fault=${service.$fault}`);
    }
    if (service.$metadata?.httpStatusCode) {
        parts.push(`http=${service.$metadata.httpStatusCode}`);
    }
    if (service.$metadata?.requestId) {
        parts.push(`requestId=${service.$metadata.requestId}`);
    }

    return parts.join(" ");
}
