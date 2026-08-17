import * as path from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";
import { app } from "electron";
import log from "electron-log/main";
import { config, DEFAULT_BEHAVIOR, type BehaviorConfig } from "./config.js";

/**
 * Log files are named `main-YYYY-MM-DD.log`, one per local day.
 *
 * electron-log's own rotation is size-based and keeps exactly one archive
 * (`main.log` plus `main.old.log`, 1MB each), so a user who hits a bug can
 * easily find the relevant lines already overwritten by the time they come to
 * report it. `resolvePathFn` is consulted per message, so switching to a dated
 * name makes the file roll over on its own at midnight.
 */
const DATED_LOG = /^main-(\d{4}-\d{2}-\d{2})\.log$/;

/** What electron-log wrote before the move to dated files. */
const LEGACY_LOGS = ["main.log", "main.old.log"];

/**
 * Captured the first time electron-log resolves a path, because that is the
 * only place it tells us where `libraryDefaultDir` actually is.
 */
let logDirectory: string | null = null;

/**
 * The local date, not `toISOString()`. A UTC date would roll the file over in
 * the middle of the working day for anyone far enough from Greenwich, which
 * defeats the point of being able to say "send me today's log".
 */
function localDate(when: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

export function configureLogging() {
    const file = log.transports.file;

    // `silly` is electron-log's default and it is more than support needs;
    // `debug` keeps the poll-by-poll detail that makes a failed login
    // diagnosable. Nothing secret is logged at either level - see the
    // redaction in aws-sso.ts.
    file.level = "debug";

    // Dated files replace size rotation. Leaving maxSize set would give us
    // both, and a `main-2026-08-17.old.log` nobody is looking for.
    file.maxSize = 0;

    // The log carries the account and role inventory, so it gets the same
    // treatment as the config file rather than the default world-readable
    // 0o666. Only applies to files we create; the sweep below retires the
    // ones earlier versions left at 0644.
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
 * Deletes log files past the retention period the user chose in Privacy.
 *
 * Reusing `historyRetentionDays` rather than adding a second setting means the
 * log carrying the account inventory ages out on the same schedule as the run
 * history describing it. Called wherever `pruneHistory()` is, so shortening
 * the period takes effect immediately rather than at the next refresh.
 *
 * Legacy `main.log`/`main.old.log` are swept by mtime. Those predate the fix
 * that stopped writing device codes to the log, so retiring them matters more
 * than the dated files do.
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
