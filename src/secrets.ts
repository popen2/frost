import { safeStorage } from "electron";
import log from "electron-log/main";

/**
 * Marks a stored value as ciphertext. Values written by versions before this
 * one carry no prefix, so they are recognisable as plaintext and get re-written
 * encrypted the next time they are set.
 */
const PREFIX = "enc:v1:";

/** Logged once rather than on every read, which happens per refresh. */
let warnedUnavailable = false;

function available(): boolean {
    // On Linux this depends on a working libsecret/kwallet; on a headless or
    // keyring-less box there is nowhere to put a key. Storing the token in the
    // clear is worse than storing it encrypted, but far better than refusing to
    // log in at all, so fall back and say so.
    if (safeStorage.isEncryptionAvailable()) {
        return true;
    }
    if (!warnedUnavailable) {
        warnedUnavailable = true;
        log.warn(
            "[secrets] OS keyring unavailable, storing credentials unencrypted"
        );
    }
    return false;
}

export function encryptSecret(value: string): string {
    if (!available()) {
        return value;
    }
    return PREFIX + safeStorage.encryptString(value).toString("base64");
}

/**
 * Returns null when a value was encrypted but cannot be read back - a copied
 * profile directory, a reset keychain, a different machine. The caller treats
 * that as "no credential", which sends the user through a fresh login rather
 * than failing somewhere further along with a confusing AWS error.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
    if (!stored) {
        return null;
    }
    if (!stored.startsWith(PREFIX)) {
        return stored;
    }
    try {
        return safeStorage.decryptString(
            Buffer.from(stored.slice(PREFIX.length), "base64")
        );
    } catch (err) {
        log.warn("[secrets] Could not decrypt a stored credential: %s", err);
        return null;
    }
}
