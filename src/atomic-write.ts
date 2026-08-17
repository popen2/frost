import { stat } from "fs/promises";
import { writeFile } from "atomically";

/** What a file Frost creates from nothing starts at. */
export const PRIVATE_MODE = 0o600;

/**
 * Writes a file the user co-owns, without disturbing the permissions they
 * chose for it. A file that does not exist yet is created 0600.
 *
 * `atomically` reuses the destination's own mode when none is given, which is
 * the whole trick - but it cannot do that for a file that is not there, and
 * its fallback is whatever the umask allows (0644 on a normal machine). Hence
 * the stat.
 *
 * Anything that must be 0600 no matter what it replaces calls `atomically`
 * directly with `{ mode: PRIVATE_MODE }`; that needs no logic and so gets no
 * wrapper.
 *
 * Doing the write by hand looked like a dozen lines and is not: a temp file
 * plus a rename replaces the *inode*, which quietly drops the destination's
 * mode, its owner, and - the one that actually bites - its identity as a
 * symlink, so a `~/.aws/config` symlinked into a dotfiles repo gets replaced
 * by a regular file and the repo silently stops being updated. atomically
 * resolves the real path first, restores mode and uid/gid, fsyncs before
 * renaming so a crash cannot leave an empty file, and retries the EPERM/EBUSY
 * Windows raises while an antivirus scanner or an AWS CLI command holds the
 * file open.
 */
export async function writeFilePreservingMode(
    fullPath: string,
    contents: string
) {
    const exists = await stat(fullPath).then(
        () => true,
        () => false
    );
    await writeFile(fullPath, contents, exists ? {} : { mode: PRIVATE_MODE });
}
