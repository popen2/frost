// End-to-end test for the login window's credential overlay.
//
//     npm run build && npx electron tools/test-login-overlay.js
//
// Headless (CI, a container): wrap it in a display —
//
//     xvfb-run -a npx electron --no-sandbox tools/test-login-overlay.js
//
// Why this exists: every part of the overlay can look right and still show the
// user nothing, and the failure is silent — no error, no log line, just a login
// window that sits there while the key waits to be touched. That is how it
// shipped broken once already: the overlay was injected on `dom-ready`, which
// is *after* the page's own scripts run, so a sign-in page that asks for the
// key as it boots (Google's security-key challenge does) had already called
// `navigator.credentials.get()` by the time there was anything to wrap.
//
// So the test drives the real thing — the real `attachLoginIndicator()` on a
// real BrowserWindow — against both orderings, and asserts the wait actually
// reached the main process. It needs no security key: only the *start* of the
// request is interesting, and that is signalled the moment the page asks.

import assert from "assert";
import http from "http";
import { createRequire } from "module";
import { app, BrowserWindow } from "electron";

import { attachLoginIndicator } from "../dist/login-indicator.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

/** Must match SIGNAL in src/login-overlay.ts. */
const SIGNAL = "__frost-login-overlay__:";

const CASE_TIMEOUT_MS = 15000;

/**
 * A `navigator.credentials.get()` for a USB security key, which is the request
 * the overlay most needs to explain. Nothing here can be answered without a key
 * plugged in, so it stays pending — exactly the state under test.
 *
 * `rpId` has to be a domain (an IP address is rejected outright), and WebAuthn
 * only runs in a secure context, which is why every page below is served from
 * `localhost`.
 */
const REQUEST = `navigator.credentials.get({
    publicKey: {
        challenge: new Uint8Array(32),
        rpId: "localhost",
        timeout: 300000,
        allowCredentials: [
            { type: "public-key", id: new Uint8Array(16), transports: ["usb"] },
        ],
        userVerification: "discouraged",
    },
}).catch(function () {})`;

const PAGES = {
    // Asks for the key while the document is still being parsed. Only an
    // injection that runs before the page's own scripts can wrap this.
    "/early": `<!doctype html><html><head><script>${REQUEST};</script></head>
        <body><h1>early</h1></body></html>`,

    // Asks well after load, the way a page with a "Use your security key"
    // button does. The `dom-ready` injection is enough for this one.
    "/late": `<!doctype html><html><body><h1>late</h1><script>
        addEventListener("load", function () {
            setTimeout(function () { ${REQUEST}; }, 250);
        });
        </script></body></html>`,
};

function serve() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const page = PAGES[req.url.split("?")[0]];
            res.writeHead(page ? 200 : 404, {
                "Content-Type": "text/html",
                // A cached page would test the cache, not the injection.
                "Cache-Control": "no-store",
            });
            res.end(page || "<!doctype html><html><body>404</body></html>");
        });
        server.on("error", reject);
        // Bound to the loopback address, reached by name: `localhost` is a
        // secure context and a usable `rpId`, `127.0.0.1` is neither.
        server.listen(0, "127.0.0.1", () =>
            resolve({ server, port: server.address().port })
        );
    });
}

/**
 * Load `path` in a window wired up exactly like the login window, and resolve
 * with what the main process learned about the wait.
 */
async function runCase(port, path) {
    const window = new BrowserWindow({
        width: 550,
        height: 700,
        show: false,
        webPreferences: { nodeIntegration: false },
    });

    const signals = [];
    window.webContents.on("console-message", (details) => {
        if (details.message.startsWith(SIGNAL)) {
            signals.push(JSON.parse(details.message.slice(SIGNAL.length)));
        }
    });

    try {
        await attachLoginIndicator(window);
        await window.webContents.loadURL(`http://localhost:${port}${path}`);

        const deadline = Date.now() + CASE_TIMEOUT_MS;
        while (!signals.some((signal) => signal.state === "start")) {
            if (Date.now() > deadline) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        return { signals, title: window.getTitle() };
    } finally {
        // close() is what the login flow itself does, so this exercises the
        // same teardown; destroy() is the belt-and-braces for a window that did
        // not go away, so one stuck case cannot leak into the next. Either way
        // the still-pending credential request goes with it.
        if (!window.isDestroyed()) window.close();
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (!window.isDestroyed()) window.destroy();
    }
}

async function check() {
    const { server, port } = await serve();

    try {
        for (const path of ["/early", "/late"]) {
            const { signals, title } = await runCase(port, path);
            const started = signals.filter((s) => s.state === "start");

            assert.ok(
                started.length > 0,
                `${path}: the overlay never reported the wait. The page asked ` +
                    `for a security key and the user was shown nothing.`
            );
            assert.strictEqual(
                started[0].kind,
                "security-key",
                `${path}: wait reported as ${started[0].kind}`
            );
            assert.strictEqual(
                title,
                "Frost — Touch your security key",
                `${path}: window title was not taken over`
            );
            console.log(`  ${path}: overlay reported the wait, title taken over`);
        }
    } finally {
        server.close();
    }
}

// Same as src/main.ts: Frost is a tray app and does not quit when its last
// window closes. Without this, tearing down the first case quits the app
// underneath the second one.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
    console.log(`login overlay test (Frost ${version})`);
    try {
        await check();
        console.log("login overlay test passed");
        app.exit(0);
    } catch (err) {
        console.error(`login overlay test FAILED\n${err}`);
        app.exit(1);
    }
});
