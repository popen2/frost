import { session } from "electron";
import log from "electron-log/main";

/**
 * Signs the user out of the login window's web content.
 *
 * That window takes no partition, so everything AWS and the identity provider
 * store lands in the default session. `clearData()` covers every storage type
 * and origin; `clearAuthCache()` is not part of it and holds cached
 * Basic/NTLM/Negotiate credentials. The electron-store - SSO settings, token,
 * profiles - is deliberately untouched.
 */
export async function clearBrowsingData(): Promise<void> {
    log.info("[clearBrowsingData] Clearing the login session");
    await session.defaultSession.clearData();
    await session.defaultSession.clearAuthCache();
    log.info("[clearBrowsingData] Cleared");
}
