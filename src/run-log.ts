import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import { config, BehaviorConfig, DEFAULT_BEHAVIOR } from "./config.js";

export interface ProfileEntry {
    accountId: string;
    accountName: string;
    roles: { roleName: string; profileName: string }[];
}

export interface EksEntry {
    profileName: string;
    regionName: string;
    status: "success" | "error";
    clusters: string[];
    error?: string;
}

export interface TokenStep {
    type: "token";
    status: "in-progress" | "success" | "error";
    error?: string;
}

export interface ProfilesStep {
    type: "profiles";
    status: "in-progress" | "success" | "error";
    error?: string;
    accounts: ProfileEntry[];
}

export interface EksStep {
    type: "eks";
    status: "in-progress" | "success" | "error";
    error?: string;
    entries: EksEntry[];
}

export type RunStep = TokenStep | ProfilesStep | EksStep;

export interface RunLog {
    runId: string;
    startedAt: string;
    endedAt?: string;
    status: "in-progress" | "success" | "error";
    error?: string;
    steps: RunStep[];
}

export const runLogEmitter = new EventEmitter();

let currentRun: RunLog | null = null;

function retentionCutoff(): string {
    const behavior =
        (config.get("behaviorConfig") as BehaviorConfig | undefined) ||
        DEFAULT_BEHAVIOR;
    const retentionDays =
        behavior.historyRetentionDays ?? DEFAULT_BEHAVIOR.historyRetentionDays;
    return new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000
    ).toISOString();
}

/**
 * Drop runs older than the configured retention period. Called at startup and
 * whenever the retention setting is saved — pruning only inside saveRun() would
 * mean a shortened retention period had no effect until the next refresh.
 */
export function pruneHistory() {
    const cutoff = retentionCutoff();
    const stored = (config.get("runHistory") as RunLog[]) || [];
    const kept = stored.filter((r) => r.startedAt >= cutoff);
    if (kept.length !== stored.length) {
        config.set("runHistory", kept as object[]);
        runLogEmitter.emit("updated");
    }
}

export function clearHistory() {
    config.set("runHistory", []);
    runLogEmitter.emit("updated");
}

function saveRun() {
    if (!currentRun) return;

    const cutoff = retentionCutoff();
    const stored = (config.get("runHistory") as RunLog[]) || [];
    const idx = stored.findIndex((r) => r.runId === currentRun!.runId);

    let updated: RunLog[];
    if (idx >= 0) {
        updated = stored.map((r, i) => (i === idx ? currentRun! : r));
    } else {
        updated = [currentRun, ...stored];
    }

    updated = updated.filter(
        (r) => r.runId === currentRun!.runId || r.startedAt >= cutoff
    );

    config.set("runHistory", updated as object[]);
    runLogEmitter.emit("updated");
}

export function getCurrentRun(): RunLog | null {
    return currentRun;
}

export function startRun(): RunLog {
    currentRun = {
        runId: uuidv4(),
        startedAt: new Date().toISOString(),
        status: "in-progress",
        steps: [],
    };
    saveRun();
    return currentRun;
}

export function completeRun(status: "success" | "error", error?: string) {
    if (!currentRun) return;
    currentRun.endedAt = new Date().toISOString();
    currentRun.status = status;
    if (error) currentRun.error = error;
    saveRun();
}

export function startTokenStep() {
    if (!currentRun) return;
    const step: TokenStep = { type: "token", status: "in-progress" };
    currentRun.steps.push(step);
    saveRun();
}

export function completeTokenStep(status: "success" | "error", error?: string) {
    if (!currentRun) return;
    const step = currentRun.steps.find(
        (s) => s.type === "token"
    ) as TokenStep | undefined;
    if (step) {
        step.status = status;
        if (error) step.error = error;
    }
    saveRun();
}

export function startProfilesStep() {
    if (!currentRun) return;
    const step: ProfilesStep = {
        type: "profiles",
        status: "in-progress",
        accounts: [],
    };
    currentRun.steps.push(step);
    saveRun();
}

export function completeProfilesStep(
    status: "success" | "error",
    accounts: ProfileEntry[],
    error?: string
) {
    if (!currentRun) return;
    const step = currentRun.steps.find(
        (s) => s.type === "profiles"
    ) as ProfilesStep | undefined;
    if (step) {
        step.status = status;
        step.accounts = accounts;
        if (error) step.error = error;
    }
    saveRun();
}

export function startEksStep() {
    if (!currentRun) return;
    const step: EksStep = { type: "eks", status: "in-progress", entries: [] };
    currentRun.steps.push(step);
    saveRun();
}

export function addEksEntry(entry: EksEntry) {
    if (!currentRun) return;
    const step = currentRun.steps.find(
        (s) => s.type === "eks"
    ) as EksStep | undefined;
    if (step) {
        step.entries.push(entry);
    }
    saveRun();
}

export function completeEksStep(status: "success" | "error", error?: string) {
    if (!currentRun) return;
    const step = currentRun.steps.find(
        (s) => s.type === "eks"
    ) as EksStep | undefined;
    if (step) {
        step.status = status;
        if (error) step.error = error;
    }
    saveRun();
}
