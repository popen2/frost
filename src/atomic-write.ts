import { chmod, mkdir, rename, stat, writeFile } from "fs/promises";
import { dirname } from "path";
import log from "electron-log/main";

/**
 * How the destination's permissions are decided.
 *
 * - `preserve` keeps whatever mode the file already has. `~/.aws/config` is
 *   the user's file and may legitimately be group-readable on a shared box, so
 *   Frost has no business tightening or loosening it.
 * - `private` forces 0600 every time. The SSO cache holds the access token,
 *   and versions up to v0.2.16 created it 0644 - preserving the existing mode
 *   there would leave every current install exposed forever.
 *
 * Either way a file Frost creates from nothing starts at 0600.
 */
export type ModePolicy = "preserve" | "private";

const PRIVATE_MODE = 0o600;

/**
 * Windows fails the rename outright - EPERM or EBUSY - while another process
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
            log.warn("[renameWithRetry] %s renaming to %s, retrying", code, to);
            await new Promise((done) =>
                setTimeout(done, RENAME_RETRY_DELAYS_MS[attempt])
            );
        }
    }
}

async function targetMode(
    fullPath: string,
    policy: ModePolicy
): Promise<number> {
    if (policy === "private") {
        return PRIVATE_MODE;
    }
    try {
        return (await stat(fullPath)).mode & 0o777;
    } catch {
        // Nothing there yet, so this is a file Frost is creating.
        return PRIVATE_MODE;
    }
}

/**
 * Writes `contents` to `fullPath` through a temp file and a rename, so an
 * interrupted run cannot leave a truncated file behind - these are files that
 * also hold things Frost does not own.
 *
 * The rename swaps in a *new inode*, which means the destination ends up with
 * the temp file's permissions rather than its own. Writing in place used to
 * hide that, because truncating an existing file leaves its mode alone. So the
 * mode has to be carried across deliberately; see {@link ModePolicy}.
 */
export async function writeFileAtomic(
    fullPath: string,
    contents: string,
    policy: ModePolicy
) {
    const tempPath = `${fullPath}.frost-tmp`;
    const mode = await targetMode(fullPath, policy);

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(tempPath, contents, { mode });

    // Twice, because `writeFile`'s mode is advisory in two ways: it is masked
    // by the umask, and it is ignored outright if the temp file survived an
    // earlier interrupted run. chmod is neither.
    await chmod(tempPath, mode);

    await renameWithRetry(tempPath, fullPath);
}
