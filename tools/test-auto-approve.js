// End-to-end tests for automatic approval.
//
//     npm run build && npx electron tools/test-auto-approve.js
//
// Headless (CI, a container): wrap it in a display —
//
//     xvfb-run -a npx electron --no-sandbox tools/test-auto-approve.js
//
// Why this exists: automatic approval is a script clicking buttons on pages
// Frost does not own, in a window the user cannot see. Every way it can be
// wrong is quiet — a button that is never found (the refresh hangs until the
// device code expires), a button that should not have been clicked (the request
// is denied), a hand-over that never happens (the user waits in front of
// nothing). None of that shows up in a type-check or in a unit test of the
// matching rules, because what makes it work is the whole path: the real device
// flow, real pages at real AWS and identity provider origins, a real hidden
// window, and the real poll loop collecting the token afterwards.
//
// So this drives `refresh()` itself — the same entry point the tray, the hotkey
// and the timer use — against a stub of AWS SSO, and asserts on what the user
// would have seen. Three interceptions make that possible, none of which asks
// the app to know it is being tested:
//
//   - `AWS_ENDPOINT_URL_SSO_OIDC` / `AWS_ENDPOINT_URL_SSO`, an AWS SDK feature,
//     point the SDK clients at the stub's HTTP server. The device
//     authorization, the polling and its AuthorizationPendingException are the
//     real client talking a real protocol to a stub service.
//   - `session.protocol.handle("https", ...)` serves the pages from memory at
//     their real names. The renderer sees `https://d-1234567890.awsapps.com`, a
//     secure context, and a genuine cross-origin redirect to the identity
//     provider — which is what the driver's host rule is written against.
//     Served from localhost this would prove nothing.
//   - `Notification` and `shell.openExternal` are recorded rather than
//     performed, because "what was the user told" and "where were they sent"
//     are the assertions, and neither a CI runner nor a developer's desktop
//     should have to grow a notification daemon or a browser window for them.
//
// `HOME` and the electron-store move into a temp directory for the duration, so
// a run touches nothing of yours.

import assert from "assert";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { app, BrowserWindow, session, shell } from "electron";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

/** The account portal, and the identity provider it federates to. */
const PORTAL = "https://d-1234567890.awsapps.com";
const IDP = "https://idp.example.test";

const USER_CODE = "ABCD-EFGH";

/** Long enough that nothing races the device code expiring. */
const DEVICE_CODE_LIFETIME_SEC = 120;

/**
 * For scenarios that end with nobody completing the login: the run finishes
 * when the code expires. Long enough to outlast the driver's 12s stall timer,
 * which is what the unrecognised-page scenario is waiting for.
 */
const STALLING_DEVICE_CODE_LIFETIME_SEC = 16;

/**
 * For scenarios that hand over immediately and then have nothing left to wait
 * for. Nothing here depends on the stall timer, so the code can be short.
 */
const SHORT_DEVICE_CODE_LIFETIME_SEC = 6;

const CASE_TIMEOUT_MS = 60000;
const POLL_MS = 100;

// ── The pages ───────────────────────────────────────────────────────────────
//
// Close enough to the real ones to exercise the rules that matter: the device
// page carries its code already filled in (the thing that must *not* read as
// "the user has to type something"), and every page carries something the
// driver must leave alone.

const STYLE = "<style>button{font-size:16px;padding:8px 16px}</style>";

function page(title, body) {
    return `<!doctype html><html><head><title>${title}</title>${STYLE}</head>
        <body><h1>${title}</h1>${body}</body></html>`;
}

/** Step one: "Authorize request". The code arrives filled in from the URL. */
const DEVICE_PAGE = page(
    "Authorize request",
    `<form onsubmit="return false">
        <input type="text" id="user_code" name="userCode" value="${USER_CODE}">
     </form>
     <button id="cli_verification_btn" onclick="location.href='/next'">
        Confirm and continue
     </button>
     <button onclick="location.href='/clicked-cancel'">Cancel</button>`
);

/** Step two: "Allow access". Its neighbour is the one that must never be hit. */
const ALLOW_PAGE = page(
    "Allow access to your data?",
    `<button id="cli_login_button" onclick="location.href='/approved'">
        Allow access
     </button>
     <button onclick="location.href='/denied'">Deny</button>`
);

const APPROVED_PAGE = page(
    "Request approved",
    "<p>You can close this window and return to Frost.</p>"
);

/** The identity provider: the one page here that is the user's to answer. */
const SIGNIN_PAGE = page(
    "Sign in",
    `<form action="/submit" method="get">
        <input type="text" name="username" placeholder="Email">
        <input type="password" name="password" placeholder="Password">
        <button type="submit">Sign in</button>
     </form>`
);

/**
 * An identity provider page wearing the portal's clothes: the very label the
 * driver is looking for, on a host that is not AWS. Clicking it would be
 * clicking a stranger's button. The password field beside it is what brings the
 * window up, so the test does not have to wait out the stall timer to see the
 * answer.
 */
const IDP_TRAP_PAGE = page(
    "Sign in to continue",
    `<button onclick="location.href='/clicked-idp-allow'">Allow access</button>
     <form action="/submit" method="get">
        <input type="password" name="password" placeholder="Password">
     </form>`
);

/**
 * A page the driver has no business touching. Three traps: a label it does not
 * know, a plain refusal, and — the one that matters most — a refusal wearing
 * the id of the button it wants, which is what AWS reusing an id on an "are you
 * sure?" page would look like.
 */
const UNKNOWN_PAGE = page(
    "Something else entirely",
    `<button onclick="location.href='/clicked-unknown'">
        Continue to the console
     </button>
     <button onclick="location.href='/clicked-cancel'">Cancel</button>
     <button id="cli_login_button" onclick="location.href='/clicked-trap'">
        Cancel request
     </button>`
);

// ── The stub ────────────────────────────────────────────────────────────────

/** Reset for each scenario; the assertions read it afterwards. */
let run = null;

function newRun(name, options = {}) {
    run = {
        name,
        // What the portal does once the request is confirmed: go straight to
        // consent, or federate to the identity provider — which either carries
        // the user through on a session it already has, asks them to sign in,
        // or tries to get Frost to click something of its own.
        idp: options.idp || "none",
        firstPage: options.firstPage || DEVICE_PAGE,
        lifetimeSec: options.lifetimeSec || DEVICE_CODE_LIFETIME_SEC,
        approved: false,
        // Every page request, API call, notification and browser hand-off, in
        // order: the assertions read it, and it is printed when one fails.
        trail: [],
        // Sampled rather than taken from the `show` event, so it holds whether
        // the window was created hidden and shown later or created visible.
        everVisible: false,
        notifications: [],
        browserOpens: [],
        tokenPolls: 0,
    };
    return run;
}

function note(what) {
    if (run) run.trail.push(what);
}

function json(body, status = 200, headers = {}) {
    return [
        status,
        { "Content-Type": "application/json", ...headers },
        JSON.stringify(body),
    ];
}

/**
 * The AWS SSO-OIDC and SSO endpoints a refresh actually calls. Only the three
 * device-flow operations and the account listing are needed: with no accounts
 * there are no profiles, and with no profiles the EKS scan returns before it
 * asks for a region.
 */
function handleApi(method, url) {
    if (method === "POST" && url === "/client/register") {
        note("oidc:register");
        return json({
            clientId: "frost-check-client",
            clientSecret: "frost-check-secret",
            clientIdIssuedAt: Math.floor(Date.now() / 1000),
            clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        });
    }

    if (method === "POST" && url === "/device_authorization") {
        note("oidc:device-authorization");
        return json({
            deviceCode: "frost-check-device-code",
            userCode: USER_CODE,
            verificationUri: `${PORTAL}/start/#/device`,
            verificationUriComplete: `${PORTAL}/start/?user_code=${USER_CODE}#/device`,
            expiresIn: run.lifetimeSec,
            // One second keeps the check quick without changing anything about
            // the loop under test.
            interval: 1,
        });
    }

    if (method === "POST" && url === "/token") {
        run.tokenPolls += 1;
        if (!run.approved) {
            note("oidc:token-pending");
            // The shape the SDK turns back into AuthorizationPendingException,
            // which is what the poll loop is written against.
            return json(
                {
                    __type: "AuthorizationPendingException",
                    error: "authorization_pending",
                    error_description: "The request is pending approval",
                },
                400,
                { "x-amzn-errortype": "AuthorizationPendingException:" }
            );
        }
        note("oidc:token-issued");
        return json({
            accessToken: "frost-check-access-token",
            tokenType: "Bearer",
            expiresIn: 28800,
        });
    }

    // ListAccounts. An empty list is a complete, successful refresh with no
    // profiles to write and no EKS scan to run.
    if (method === "GET" && url.startsWith("/assignment/accounts")) {
        note("sso:list-accounts");
        return json({ accountList: [] });
    }

    note(`api:unhandled ${method} ${url}`);
    return json({ __type: "InternalServerException" }, 500);
}

function startApiStub() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                const [status, headers, payload] = handleApi(
                    req.method,
                    req.url
                );
                res.writeHead(status, headers);
                res.end(payload);
            });
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () =>
            resolve({ server, port: server.address().port })
        );
    });
}

/**
 * Serve the pages under their real names. The driver only clicks on the AWS
 * portal's own hosts, so where these come from is part of what is being tested.
 */
function interceptPages() {
    session.defaultSession.protocol.handle("https", (request) => {
        const url = new URL(request.url);
        note(`page:${url.origin}${url.pathname}`);

        const html = (body) =>
            new Response(body, {
                status: 200,
                headers: {
                    "Content-Type": "text/html",
                    "Cache-Control": "no-store",
                },
            });

        const redirect = (to) =>
            new Response(null, { status: 302, headers: { Location: to } });

        if (url.origin === PORTAL) {
            switch (url.pathname) {
                case "/start/":
                    return html(run.firstPage);
                case "/next":
                    // A confirmed request either goes straight to consent or
                    // federates out. The redirect is the real shape of that
                    // hop, and it moves the page to another origin — and
                    // another renderer process.
                    return run.idp === "none"
                        ? html(ALLOW_PAGE)
                        : redirect(`${IDP}/signin`);
                case "/allow":
                    return html(ALLOW_PAGE);
                case "/approved":
                    // The moment that makes the device code redeemable, which
                    // is why no token appears without a real click.
                    run.approved = true;
                    return html(APPROVED_PAGE);
                default:
                    return html(page("Unexpected", `<p>${url.pathname}</p>`));
            }
        }

        if (url.origin === IDP) {
            // Signed in; back to the portal for the consent step, which is the
            // driver's again.
            if (url.pathname === "/submit") return redirect(`${PORTAL}/allow`);
            if (run.idp === "live") return redirect(`${PORTAL}/allow`);
            if (run.idp === "trap") return html(IDP_TRAP_PAGE);
            return html(SIGNIN_PAGE);
        }

        return new Response("not found", { status: 404 });
    });
}

// ── Watching what the user would have seen ──────────────────────────────────

let sampler = null;

/**
 * Sampled, not taken from the window's `show` event: "was anything ever put in
 * front of the user" has to hold for a window created visible as much as for
 * one revealed later, and the scenarios need both.
 */
function sampleWindows() {
    sampler = setInterval(() => {
        if (!run || run.everVisible) return;
        const visible = BrowserWindow.getAllWindows().some(
            (window) => !window.isDestroyed() && window.isVisible()
        );
        if (visible) {
            run.everVisible = true;
            note("window:visible");
        }
    }, POLL_MS);
}

function visibleWindow() {
    return BrowserWindow.getAllWindows().find(
        (window) => !window.isDestroyed() && window.isVisible()
    );
}

/**
 * Record what the user is told instead of telling them.
 *
 * On the prototype, not by swapping the class: `Notification` is a
 * non-configurable export of the electron module, and every `new
 * Notification(...)` in the app reaches this either way. Nothing is passed
 * through to the real `show()` — a CI container has no notification daemon,
 * and the assertion is that Frost said something, not that a desktop drew it.
 */
function recordNotifications() {
    const { Notification } = require("electron");
    Notification.prototype.show = function () {
        note(`notification:${this.title}`);
        if (run) run.notifications.push({ title: this.title, body: this.body });
    };
    return typeof Notification.prototype.show === "function";
}

/** Record where the user would have been sent, without opening a browser. */
function recordBrowserOpens() {
    shell.openExternal = async (url) => {
        note(`browser:${url}`);
        if (run) run.browserOpens.push(url);
    };
}

// ── Waiting ─────────────────────────────────────────────────────────────────

function describe() {
    return `${run.name}\n         trail: ${run.trail.join("\n                ")}`;
}

function fail(what) {
    return new Error(`${what}\n       ${describe()}`);
}

function check(condition, what) {
    assert.ok(condition, fail(what).message);
}

async function waitFor(predicate, what, timeoutMs = CASE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = predicate();
        if (value) return value;
        if (Date.now() > deadline) throw fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function withTimeout(promise, what, timeoutMs = CASE_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(
            () => reject(fail(`timed out waiting for ${what}`)),
            timeoutMs
        );
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** Stand in for the user at the identity provider's sign-in form. */
async function signInOnPage(window) {
    await window.webContents.executeJavaScript(`
        (function () {
            var text = document.querySelector('input[type=text]');
            if (text) text.value = "someone@example.com";
            var password = document.querySelector('input[type=password]');
            if (password) password.value = "hunter2";
            document.querySelector('form').submit();
        })();
    `);
}

/**
 * Give up the way the user does. `close()`, not `destroy()`: closing is what
 * tells the poll loop nobody is signing in, and it is the path that has to
 * survive a remote page's `beforeunload`.
 */
function closeVisibleWindow() {
    const window = visibleWindow();
    if (window) window.close();
}

// ── Scenarios ───────────────────────────────────────────────────────────────

/**
 * The case the feature exists for: a portal session that carries the user
 * through, and a refresh that finishes with nothing on screen.
 */
async function silentApproval(frost) {
    newRun("a refresh nobody has to see");

    await withTimeout(frost.refresh(), "the refresh to finish");

    check(run.approved, "the request was never approved");
    check(!run.everVisible, "the login window was shown");
    check(frost.hasToken(), "no token was stored");
    check(
        run.notifications.length === 0,
        "the user was notified about a refresh that needed nothing from them"
    );
}

/**
 * The same, the long way round: AWS federates to the identity provider, which
 * still has a session and hands the user straight back. A cross-origin hop is
 * not by itself a reason to show anybody anything.
 */
async function silentApprovalThroughIdp(frost) {
    newRun("a federated refresh nobody has to see", { idp: "live" });

    await withTimeout(frost.refresh(), "the refresh to finish");

    check(
        run.trail.includes(`page:${IDP}/signin`),
        "the identity provider was never reached"
    );
    check(run.approved, "the request was never approved");
    check(!run.everVisible, "the login window was shown");
    check(frost.hasToken(), "no token was stored");
}

/**
 * The identity provider wants a password. That is the user's to answer, so the
 * window has to come up — and the approval steps after they sign in are Frost's
 * again.
 */
async function signInShowsTheWindow(frost) {
    newRun("a federated refresh that needs the user", { idp: "signin" });

    const refreshing = frost.refresh();
    const window = await waitFor(visibleWindow, "the login window to be shown");

    check(
        run.trail.includes(`page:${IDP}/signin`),
        "the window came up before the sign-in page did"
    );

    await signInOnPage(window);
    await withTimeout(refreshing, "the refresh to finish");

    check(run.approved, "the request was never approved");
    check(frost.hasToken(), "no token was stored");
}

/**
 * Notify mode is a promise not to put a login page in front of the user
 * unannounced. Under automatic approval that means a notification at the moment
 * the sign-in turns out to need them — and nothing on screen until they say so.
 */
async function notifyModeAsksFirst(frost) {
    newRun("a refresh that needs the user, in notify mode", { idp: "signin" });

    const refreshing = frost.refresh();
    await waitFor(frost.hasPendingAuth, "Frost to ask before showing the login");

    check(!run.everVisible, "the login window was shown without asking");
    check(
        run.notifications.some((options) => /sign-in/i.test(options.title)),
        "no sign-in notification was raised"
    );

    // The user presses the hotkey, or clicks the notification.
    frost.triggerPendingAuth();

    const window = await waitFor(
        visibleWindow,
        "the login window after the go-ahead"
    );
    await signInOnPage(window);
    await withTimeout(refreshing, "the refresh to finish");

    check(frost.hasToken(), "no token was stored");
}

/**
 * Someone who picked the default browser picked it because that is where their
 * passkeys and saved passwords are. The silent attempt is only a probe: the
 * moment it needs them, the browser gets the login and the probe goes away.
 */
async function defaultBrowserHandsOver(frost) {
    newRun("a refresh that needs the user, in default-browser mode", {
        idp: "signin",
        lifetimeSec: SHORT_DEVICE_CODE_LIFETIME_SEC,
    });

    const refreshing = frost.refresh();
    await waitFor(
        () => run.browserOpens.length > 0,
        "the login to be handed to the browser"
    );

    check(
        run.browserOpens[0].includes(USER_CODE),
        `the browser was sent somewhere unexpected: ${run.browserOpens[0]}`
    );
    check(
        !run.everVisible,
        "a window was shown to someone who asked for their browser"
    );

    // Nobody finishes it over there, so the run ends with the device code.
    await withTimeout(refreshing, "the refresh to give up");
    check(!frost.hasToken(), "a token appeared from nowhere");
}

/**
 * With the setting off, nothing is driven and nothing is hidden: the login
 * window is on screen from the start, exactly as it was before the feature.
 */
async function settingOffShowsEverything(frost) {
    newRun("a refresh with automatic approval switched off", {
        lifetimeSec: SHORT_DEVICE_CODE_LIFETIME_SEC,
    });

    const refreshing = frost.refresh();
    await waitFor(visibleWindow, "the login window to be shown");

    // Long enough that a driver, if one were attached, would have clicked.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    check(
        !run.trail.includes(`page:${PORTAL}/next`),
        "something confirmed the request with the setting off"
    );
    check(!run.approved, "the request was approved anyway");

    closeVisibleWindow();
    await withTimeout(refreshing, "the refresh to end after the window closed");
    check(!frost.hasToken(), "a token appeared from nowhere");
}

/**
 * The identity provider's pages are not Frost's to drive, however familiar
 * their buttons look. This one offers exactly the label the driver wants.
 */
async function identityProviderIsNotOursToClick(frost) {
    newRun("an identity provider offering a button of our own name", {
        idp: "trap",
        lifetimeSec: SHORT_DEVICE_CODE_LIFETIME_SEC,
    });

    const refreshing = frost.refresh();
    await waitFor(visibleWindow, "the login window to be shown");

    check(
        !run.trail.some((entry) => entry.includes("/clicked-idp-allow")),
        "the driver clicked a button on the identity provider"
    );
    check(!run.approved, "the request was approved");

    closeVisibleWindow();
    await withTimeout(refreshing, "the refresh to end after the window closed");
    check(!frost.hasToken(), "a token appeared from nowhere");
}

/**
 * A page with nothing the driver recognises, and two refusals next to it — one
 * carrying the id of the button it wants. Clicking any of them denies the
 * request; the right answer is to touch nothing and let the user look at it.
 */
async function unknownPageHandsOver(frost) {
    newRun("a page the driver does not recognise", {
        firstPage: UNKNOWN_PAGE,
        lifetimeSec: STALLING_DEVICE_CODE_LIFETIME_SEC,
    });

    const refreshing = frost.refresh();
    await waitFor(
        visibleWindow,
        "the login window to be shown for a page nobody could drive"
    );

    check(
        !run.trail.some((entry) => entry.includes("/clicked-")),
        "the driver clicked something it should not have"
    );
    check(!run.approved, "the request was approved");

    closeVisibleWindow();
    await withTimeout(refreshing, "the refresh to end after the window closed");
    check(!frost.hasToken(), "a token appeared from nowhere");
}

const TESTS = [
    ["silent approval: token collected, nothing shown", silentApproval, {}],
    [
        "federated session: the identity provider hop stays silent too",
        silentApprovalThroughIdp,
        {},
    ],
    [
        "sign-in needed: window shown, approval finished afterwards",
        signInShowsTheWindow,
        {},
    ],
    [
        "notify mode: notified first, shown only on the go-ahead",
        notifyModeAsksFirst,
        { refreshMode: "notify" },
    ],
    [
        "default browser: handed over there, no window shown",
        defaultBrowserHandsOver,
        { loginMethod: "default_browser" },
    ],
    [
        "setting off: window shown from the start, nothing driven",
        settingOffShowsEverything,
        { autoApprove: false },
    ],
    [
        "identity provider: its buttons are never clicked",
        identityProviderIsNotOursToClick,
        {},
    ],
    [
        "unrecognised page: nothing clicked, not even the id trap, window shown",
        unknownPageHandsOver,
        {},
    ],
];

// ── Wiring ──────────────────────────────────────────────────────────────────

async function main() {
    console.log(`auto-approve end-to-end tests (Frost ${version})`);

    // Everything the app writes goes here, and is thrown away at the end.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frost-check-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    app.setPath("userData", path.join(home, "userData"));
    app.setPath("logs", path.join(home, "logs"));

    const { server, port } = await startApiStub();
    const endpoint = `http://127.0.0.1:${port}`;
    process.env.AWS_ENDPOINT_URL_SSO_OIDC = endpoint;
    process.env.AWS_ENDPOINT_URL_SSO = endpoint;
    process.env.AWS_REGION = "us-east-1";
    // The device-flow calls are unauthenticated, but the SDK still resolves a
    // credential chain; without these it would go looking for real ones.
    process.env.AWS_ACCESS_KEY_ID = "frost-check";
    process.env.AWS_SECRET_ACCESS_KEY = "frost-check";

    await app.whenReady();

    // The app quits by default once the last window closes, and every scenario
    // here closes one — src/main.ts holds it open with the same handler.
    app.on("window-all-closed", () => {});

    interceptPages();
    sampleWindows();
    recordBrowserOpens();
    assert.ok(
        recordNotifications(),
        "could not record notifications; the tests cannot tell what the user was told"
    );

    // Imported after the paths are redirected and the recorders are in place:
    // the store is constructed on import, and the app's modules capture
    // `Notification` as they are evaluated.
    const { config } = await import("../dist/config.js");
    const { refresh, cancelTokenRefresh, hasPendingAuth, triggerPendingAuth } =
        await import("../dist/aws-sso.js");

    const frost = {
        refresh,
        hasPendingAuth,
        triggerPendingAuth,
        hasToken: () => {
            const expiresAt = config.get("expiresAt");
            return Boolean(expiresAt) && Date.parse(expiresAt) > Date.now();
        },
        reset: (behavior) => {
            cancelTokenRefresh();
            config.set("isWorking", false);
            config.delete("accessToken");
            config.delete("expiresAt");
            config.delete("ssoClient");
            config.set("userConfig", {
                startUrl: `${PORTAL}/start`,
                region: "us-east-1",
            });
            config.set("behaviorConfig", {
                refreshMode: "auto",
                refreshHotkey: "CmdOrCtrl+Shift+R",
                historyRetentionDays: 7,
                loginMethod: "popup",
                autoApprove: true,
                ...behavior,
            });
        },
    };

    let failures = 0;
    for (const [label, scenario, behavior] of TESTS) {
        frost.reset(behavior);
        const startedAt = Date.now();
        try {
            await scenario(frost);
            console.log(
                `  ok   ${label} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
            );
        } catch (err) {
            failures += 1;
            console.error(`  FAIL ${label}\n       ${err.message}`);
        }
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.destroy();
        }
    }

    clearInterval(sampler);
    cancelTokenRefresh();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });

    if (failures) {
        console.error(`\n${failures} of ${TESTS.length} failing`);
        app.exit(1);
        return;
    }
    console.log(`auto-approve end-to-end tests passed (${TESTS.length} scenarios)`);
    app.exit(0);
}

main().catch((err) => {
    console.error(err);
    app.exit(1);
});
