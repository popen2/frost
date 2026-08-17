import { stat } from "fs/promises";
import { writeFile } from "atomically";

/**
 * How the destination's permissions are decided.
 *
 * - `preserve` keeps whatever mode the file already has. `~/.aws/config` and
 *   `~/.kube/config` are the user's files and may legitimately be
 *   group-readable on a shared box, so Frost has no business tightening or
 *   loosening them.
 * - `private` forces 0600 every time. The SSO cache holds the access token,
 *   and versions up to v0.2.16 created it 0644 - preserving the existing mode
 *   there would leave every current install exposed forever.
 *
 * Either way a file Frost creates from nothing starts at 0600.
 */
export type ModePolicy = "preserve" | "private";

const PRIVATE_MODE = 0o600;

async function modeOption(
    fullPath: string,
    policy: ModePolicy
): Promise<{ mode?: number }> {
    if (policy === "private") {
        return { mode: PRIVATE_MODE };
    }

    // Omitting `mode` is what makes atomically reuse the destination's own
    // permissions, which is the whole of "preserve". It cannot do that for a
    // file that does not exist yet, and its fallback is whatever the umask
    // allows - 0644 on a normal machine - so say 0600 when we are the one
    // creating the file.
    const exists = await stat(fullPath).then(
        () => true,
        () => false
    );
    return exists ? {} : { mode: PRIVATE_MODE };
}

/**
 * Writes `contents` to `fullPath` without ever letting a reader see a half
 * written file, and without changing permissions that are not ours to change.
 *
 * The work is `atomically`'s, which electron-store already depends on, so this
 * is only the policy above. Doing it by hand looked like a dozen lines and is
 * not: a temp file plus a rename replaces the *inode*, which quietly drops the
 * destination's mode, its owner, and - the one that actually bites - its
 * identity as a symlink, so `~/.aws/config` symlinked into a dotfiles repo
 * gets replaced by a regular file and the repo silently stops being updated.
 * atomically resolves the real path first, restores mode and uid/gid, fsyncs
 * before renaming so a crash cannot leave an empty file, and retries the
 * EPERM/EBUSY that Windows raises while an antivirus scanner or an AWS CLI
 * command holds the file open.
 */
export async function writeFileAtomic(
    fullPath: string,
    contents: string,
    policy: ModePolicy
) {
    await writeFile(fullPath, contents, await modeOption(fullPath, policy));
}
