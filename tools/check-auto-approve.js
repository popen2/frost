// End-to-end check for automatic approval.
//
//     npm run build && npx electron tools/check-auto-approve.js
//
// Headless (CI, a container): wrap it in a display —
//
//     xvfb-run -a npx electron --no-sandbox tools/check-auto-approve.js
//
// Why this exists: automatic approval is a script clicking buttons on pages
// Frost does not own, in a window the user cannot see. Every way it can be
// wrong is quiet — a button that is never found (the refresh hangs until the
// device code expires), a button that should not have been clicked (the request
// is denied), a hand-over that never happens (the user waits in front of
// nothing). None of that shows up in a type-check or a unit test of the
// matching rules, because what makes it work is the whole path: the real device
// flow, a real page at a real AWS origin, a real hidden window, the real poll
// loop collecting the token afterwards.
//
// So this drives `refresh()` itself — the same entry point the tray, the hotkey
// and the timer use — against a stub of AWS SSO. Two interceptions make that
// possible, neither of which asks the app to know it is being tested:
//
//   - `AWS_ENDPOINT_URL_SSO_OIDC` / `AWS_ENDPOINT_URL_SSO`, an AWS SDK feature,
//     point the SDK clients at the stub's HTTP server. The device
//     authorization, the polling and its AuthorizationPendingException are the
//     real client talking a real protocol to a stub service.
//   - `session.protocol.handle("https", ...)` serves the verification pages
//     from memory at their real names. The renderer sees
//     `https://d-1234567890.awsapps.com`, a secure context, and a genuine
//     cross-origin navigation to the identity provider — which is what the
//     driver's host rule is written against.
//
// `~/.aws`, `~/.kube` and the electron-store all move into a temp directory for
// the duration, so a run touches nothing of the user's.

import assert from "assert";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { app, BrowserWindow, session } from "electron";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

/** The account portal, and the identity provider it hands off to. */
const PORTAL = "https://d-1234567890.awsapps.com";
const IDP = "https://idp.example.test";

const USER_CODE = "ABCD-EFGH";

/** Long enough that nothing here races the device code expiring. */
const DEVICE_CODE_LIFETIME_SEC = 120;

/**
 * A scenario is done when its promise settles; this is the backstop. It has to
 * clear the driver's stall timer (12s), which is what the third scenario is
 * waiting for.
 */
const CASE_TIMEOUT_MS = 45000;

// ── The pages ───────────────────────────────────────────────────────────────
//
// Close enough to the real ones to exercise the rules that matter: the device
// page carries its code already filled in (the thing that must *not* read as
// "the user has to type something"), and every page carries a control the
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
     <button onclick="location.href='/cancelled'">Cancel</button>`
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
 * A page the driver has no business touching. Three traps: a label it does not
 * know, a plain refusal, and — the one that matters most — a refusal wearing
 * the id of the button it is looking for, which is what AWS reusing an id on a
 * "are you sure?" page would look like. The right outcome is that it clicks
 * none of them and the window comes up.
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

function newRun(name, options) {
    run = {
        name,
        // Which page the portal serves once the request is confirmed.
        needsSignIn: options.needsSignIn === true,
        firstPage: options.firstPage || DEVICE_PAGE,
        approved: false,
        // Every page request and every OIDC call, in order, for the assertions
        // and for the failure message when one of them does not hold.
        trail: [],
        windowsShown: 0,
        tokenPolls: 0,
    };
    return run;
}

function note(what) {
    run.trail.push(what);
}

function json(body, status = 200, headers = {}) {
    return [status, { "Content-Type": "application/json", ...headers }, JSON.stringify(body)];
}

/**
 * The AWS SSO-OIDC and SSO endpoints the refresh actually calls. Only the three
 * device-flow operations and the account listing are needed: with no accounts
 * there are no profiles, and with no profiles the EKS scan returns before it
 * asks for a region.
 */
function handleApi(method, url, body) {
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
            expiresIn: DEVICE_CODE_LIFETIME_SEC,
            // The poll interval. One second keeps the check quick without
            // changing anything about the loop being tested.
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
                    req.url,
                    body
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
 * Serve the verification pages under their real names. The driver only clicks
 * on the AWS portal's own hosts, so a check served from localhost would prove
 * nothing at all.
 */
function interceptPages() {
    session.defaultSession.protocol.handle("https", (request) => {
        const url = new URL(request.url);
        const where = `${url.origin}${url.pathname}`;
        note(`page:${where}`);

        const html = (body) =>
            new Response(body, {
                status: 200,
                headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
            });

        const redirect = (to) =>
            new Response(null, { status: 302, headers: { Location: to } });

        if (url.origin === PORTAL) {
            switch (url.pathname) {
                case "/start/":
                    return html(run.firstPage);
                case "/next":
                    // What the portal does with a confirmed request: send the
                    // user to the identity provider if it has to, otherwise
                    // straight on to consent. The redirect is the real shape of
                    // this hop, and it is the one that moves the page to
                    // another origin — and another renderer process.
                    return run.needsSignIn
                        ? redirect(`${IDP}/signin`)
                        : html(ALLOW_PAGE);
                case "/allow":
                    return html(ALLOW_PAGE);
                case "/approved":
                    // The moment that makes the device code redeemable, which
                    // is why the token only appears after a real click.
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
            return html(SIGNIN_PAGE);
        }

        return new Response("not found", { status: 404 });
    });
}

// ── Watching the window ─────────────────────────────────────────────────────

let onWindowShown = null;

function watchWindows() {
    app.on("browser-window-created", (_event, window) => {
        window.on("show", () => {
            run.windowsShown += 1;
            note("window:shown");
            if (onWindowShown) onWindowShown(window);
        });
    });
}

/** The login window, whether or not it has been shown. */
function loginWindow() {
    return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
}

// ── Scenarios ───────────────────────────────────────────────────────────────

function describe() {
    return `${run.name}\n     trail: ${run.trail.join("\n            ")}`;
}

async function withTimeout(promise, what) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error(`timed out waiting for ${what}\n  ${describe()}`)),
            CASE_TIMEOUT_MS
        );
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * A live identity provider session: the whole thing happens with nothing on
 * screen. This is the case the feature exists for.
 */
async function checkSilentApproval(frost) {
    newRun("a refresh nobody has to see", {});

    await withTimeout(frost.refresh(), "the refresh to finish");

    assert.ok(run.approved, `the request was never approved\n  ${describe()}`);
    assert.strictEqual(
        run.windowsShown,
        0,
        `the login window was shown\n  ${describe()}`
    );
    assert.ok(
        frost.hasToken(),
        `no token was stored\n  ${describe()}`
    );
    assert.ok(
        run.trail.includes(`page:${PORTAL}/approved`),
        `the approval page was never reached\n  ${describe()}`
    );
    console.log("  ok   silent approval: token collected, nothing shown");
}

/**
 * The page asks for a password. Frost has to give up and show the window — and
 * then pick the flow back up once the user has signed in.
 */
async function checkSignInHandOver(frost) {
    newRun("a refresh that needs the user", { needsSignIn: true });

    onWindowShown = async (window) => {
        // Stand in for the user: fill the form in and submit it. What happens
        // after that is the driver's job again.
        try {
            await window.webContents.executeJavaScript(`
                document.querySelector('input[type=text]').value = "someone@example.com";
                document.querySelector('input[type=password]').value = "hunter2";
                document.querySelector('form').submit();
            `);
        } catch (err) {
            console.error("  could not sign in on the page:", err);
        }
    };

    await withTimeout(frost.refresh(), "the refresh to finish");
    onWindowShown = null;

    assert.ok(
        run.windowsShown > 0,
        `the window stayed hidden while the page asked for a password\n  ${describe()}`
    );
    assert.ok(
        run.trail.includes(`page:${IDP}/signin`),
        `the sign-in page was never reached\n  ${describe()}`
    );
    assert.ok(frost.hasToken(), `no token was stored\n  ${describe()}`);
    console.log(
        "  ok   sign-in needed: window shown, approval finished afterwards"
    );
}

/**
 * A page with nothing the driver recognises, and two refusals next to it — one
 * of them carrying the id of the button it wants. Clicking any of them denies
 * the request; the right answer is to touch nothing and let the user look at
 * it.
 */
async function checkUnknownPageHandsOver(frost) {
    newRun("a page the driver does not recognise", {
        firstPage: UNKNOWN_PAGE,
    });

    // Ending the run as the user would, so the check does not sit through the
    // device code's whole lifetime.
    onWindowShown = (window) => {
        setTimeout(() => {
            if (!window.isDestroyed()) window.close();
        }, 250);
    };

    await withTimeout(frost.refresh(), "the refresh to finish");
    onWindowShown = null;

    assert.ok(
        run.windowsShown > 0,
        `the window never came up for a page nobody could drive\n  ${describe()}`
    );
    assert.ok(
        !run.trail.some((entry) => entry.includes("/clicked-")),
        `the driver clicked something it should not have\n  ${describe()}`
    );
    assert.ok(!run.approved, `the request was approved\n  ${describe()}`);
    console.log(
        "  ok   unrecognised page: nothing clicked, not even the id trap, window shown"
    );
}

// ── Wiring ──────────────────────────────────────────────────────────────────

async function main() {
    console.log(`auto-approve end-to-end check (Frost ${version})`);

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
    // here closes one — src/main.ts holds the app open with the same handler.
    app.on("window-all-closed", () => {});

    interceptPages();
    watchWindows();

    // Imported after the paths are redirected: the store is constructed on
    // import, and it would otherwise land in the real profile directory.
    const { config } = await import("../dist/config.js");
    const { refresh, cancelTokenRefresh } = await import("../dist/aws-sso.js");

    const frost = {
        refresh,
        hasToken: () => {
            const expiresAt = config.get("expiresAt");
            return Boolean(expiresAt) && Date.parse(expiresAt) > Date.now();
        },
        reset: () => {
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
            });
        },
    };

    const checks = [
        checkSilentApproval,
        checkSignInHandOver,
        checkUnknownPageHandsOver,
    ];

    let failures = 0;
    for (const check of checks) {
        frost.reset();
        try {
            await check(frost);
        } catch (err) {
            failures += 1;
            console.error(`  FAIL ${err.message}`);
        }
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) window.destroy();
        }
    }

    cancelTokenRefresh();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });

    if (failures) {
        console.error(`\n${failures} failing`);
        app.exit(1);
        return;
    }
    console.log("auto-approve end-to-end check OK");
    app.exit(0);
}

main().catch((err) => {
    console.error(err);
    app.exit(1);
});
