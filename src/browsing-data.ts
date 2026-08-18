import { session } from "electron";
import log from "electron-log/main";

/**
 * Erases everything the login window's web content left behind.
 *
 * That window is created without a partition of its own, so the cookies, local
 * storage and cached responses AWS and the identity provider write all land in
 * the default session and survive restarts. That persistence is the point most
 * of the time - it is what lets a federated login refresh without interrupting
 * anyone - but it also means an identity provider session that is wrong (signed
 * in as the other account) or wedged cannot be escaped from inside the app.
 *
 * `clearData()` with no arguments empties every data type Chromium's
 * BrowsingDataRemover knows about, for every origin: cookies, local storage,
 * IndexedDB, service workers and the HTTP cache. `clearAuthCache()` is not part
 * of that and is cleared separately - it holds the Basic/NTLM/Negotiate
 * credentials a corporate identity provider may have cached.
 *
 * None of this touches the AWS SSO configuration: the start URL, region, token
 * and discovered profiles live in the electron-store, not in the session.
 */
export async function clearBrowsingData(): Promise<void> {
    log.info("[clearBrowsingData] Clearing the login session");
    await session.defaultSession.clearData();
    await session.defaultSession.clearAuthCache();
    log.info("[clearBrowsingData] Cleared");
}
