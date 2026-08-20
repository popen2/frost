import { stat } from "fs/promises";
import { writeFile } from "atomically";

/** What a file Frost creates from nothing starts at. */
export const PRIVATE_MODE = 0o600;

/**
 * Writes a file the user co-owns without disturbing the permissions they chose
 * for it; one that does not exist yet is created 0600.
 *
 * `atomically` reuses the destination's mode only when the destination is
 * already there - otherwise it falls back to the umask, which is 0644. Hence
 * the stat. Anything that must be 0600 whatever it replaces calls `atomically`
 * directly and needs no wrapper.
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
