/**
 * The overlay Frost injects into its AWS SSO login window.
 *
 * Electron ships no UI of its own for the Web Authentication API: when a page
 * calls `navigator.credentials.get()` the request just hangs there, silently,
 * until the security key is touched. In a normal browser that moment is a
 * modal prompt ("Insert your security key and touch it"); in Frost's login
 * window it looked exactly like a page that had stopped responding — the
 * complaint behind issue #17.
 *
 * Unlike every other file in `src/`, this one runs **in the browser** — in the
 * page's own JavaScript world, on pages we do not control (AWS, plus whatever
 * identity provider it redirects to). `npm run build:overlay` compiles it on
 * its own (`tsconfig.overlay.json`: DOM types, no Node types, plain-script
 * output) and `src/login-indicator.ts` reads the emitted `dist/login-overlay.js`
 * back as text to inject into every document the login window loads. Because
 * of where it lands it is written defensively:
 *
 * -   It wraps `navigator.credentials.{get,create}` rather than guessing from
 *     page content, so the toast appears exactly while a request is pending
 *     and disappears the moment it settles — however it settles.
 * -   It never blocks input (`pointer-events: none`). Sign-in pages often keep
 *     a "try another way" link usable while the authenticator request runs.
 * -   It renders into a closed shadow root, so page CSS cannot reach into it
 *     and its own styles cannot leak out.
 * -   It avoids `innerHTML` and `<style>` elements. Identity providers commonly
 *     serve a strict CSP (and sometimes Trusted Types), either of which would
 *     reject those; `createElement` plus a constructed stylesheet is not
 *     subject to either.
 * -   It treats everything the page hands it as `unknown` and narrows. The
 *     request options are the sign-in page's data, not ours.
 *
 * Waits are reported to the main process by logging a magic prefix to the
 * console — the only channel a script in the page's world has to the main
 * process without a preload script (see `LOGIN_OVERLAY_SIGNAL`).
 */
(() => {
    "use strict";

    const FLAG = "__frostLoginOverlay";

    /** The page's globals are not typed for our own bookkeeping. */
    const flags = window as unknown as Record<string, boolean | undefined>;
    if (flags[FLAG]) return;
    flags[FLAG] = true;

    /** Must match LOGIN_OVERLAY_SIGNAL in src/login-indicator.ts. */
    const SIGNAL = "__frost-login-overlay__:";

    /** How long a wait runs before the toast switches to its nudge text. */
    const NUDGE_AFTER_MS = 9000;

    /** Time for the leave animation, after which the host is detached. */
    const LEAVE_MS = 200;

    const credentials = window.navigator.credentials;
    if (!credentials) return;

    type Kind =
        | "security-key"
        | "passkey"
        | "register-key"
        | "register-passkey"
        | "otp"
        | "password";

    type IconName = "key" | "fingerprint" | "lock";

    interface Notice {
        icon: IconName;
        title: string;
        detail: string;
        nudge: string;
    }

    /**
     * What the page passed to `navigator.credentials` — described as loosely
     * as it actually arrives. The DOM lib's `CredentialRequestOptions` is too
     * optimistic to describe an argument that comes from a remote page, and
     * too narrow: it has no `federated`, and `identity` comes and goes between
     * TypeScript releases.
     */
    interface CredentialOptions {
        mediation?: unknown;
        publicKey?: {
            allowCredentials?: unknown;
            authenticatorSelection?: { authenticatorAttachment?: unknown };
        };
        otp?: unknown;
        password?: unknown;
        federated?: unknown;
        identity?: unknown;
    }

    /**
     * Transports that mean "something the user physically holds". Anything
     * else ("internal", "hybrid") is answered by the device itself or by a
     * phone, so the copy should talk about passkeys rather than about a key to
     * plug in and touch.
     */
    const ROAMING_TRANSPORTS = ["usb", "nfc", "ble", "smart-card"];

    /**
     * Each notice leads with the thing to do, not with the fact that Frost is
     * blocked — the user's next move is the useful half. The nudge replaces the
     * detail once the wait has gone on long enough to feel like something has
     * gone wrong, and says what to try.
     */
    const COPY: Record<Kind, Notice> = {
        "security-key": {
            icon: "key",
            title: "Touch your security key",
            detail: "Insert it if you haven't, then press the button to sign in.",
            nudge: "Still listening. Try removing the key and inserting it again.",
        },
        passkey: {
            icon: "fingerprint",
            title: "Confirm with your passkey",
            detail: "Approve the request on your device to continue.",
            nudge: "Still listening for your approval.",
        },
        "register-key": {
            icon: "key",
            title: "Register your security key",
            detail: "Press the button on your key to finish setting it up.",
            nudge: "Still listening. Try removing the key and inserting it again.",
        },
        "register-passkey": {
            icon: "fingerprint",
            title: "Create your passkey",
            detail: "Approve the request on your device to finish.",
            nudge: "Still listening for your approval.",
        },
        otp: {
            icon: "lock",
            title: "Watching for your one-time code",
            detail: "It will be filled in as soon as the code arrives.",
            nudge: "Still watching. You can also type the code in yourself.",
        },
        password: {
            icon: "lock",
            title: "Looking for a saved login",
            detail: "The page asked your password manager to fill this in.",
            nudge: "Still looking. You may need to type it in yourself.",
        },
    };

    const ICONS: Record<IconName, string[]> = {
        key: [
            "M8.4 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z",
            "M11.8 12H21",
            "M18.1 12v3.2",
            "M15.1 12v2.2",
        ],
        fingerprint: [
            "M4.2 16.4c-.1-.8-.2-1.7-.2-2.5a8 8 0 0 1 16 0c0 .8-.1 1.7-.2 2.5",
            "M6.4 18.8c.4-1.6.6-3.2.6-4.9a5 5 0 0 1 10 0c0 1.7.2 3.3.6 4.9",
            "M9.2 20c.4-1.9.8-4 .8-6a2 2 0 0 1 4 0c0 2 .4 4.1.8 6",
        ],
        lock: [
            "M7.6 10.4V8.2a4.4 4.4 0 0 1 8.8 0v2.2",
            "M6.8 10.4h10.4a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H6.8a1.4 1.4 0 0 1-1.4-1.4v-6a1.4 1.4 0 0 1 1.4-1.4Z",
        ],
    };

    /**
     * Pinned to the host element with `!important` so no page stylesheet can
     * move, clip or hide the toast. `all: initial` must come first: it resets
     * everything, including whatever the page's `*` rules would apply.
     */
    const HOST_STYLE = [
        ["all", "initial"],
        ["position", "fixed"],
        ["left", "0"],
        ["right", "0"],
        ["bottom", "0"],
        ["display", "block"],
        ["z-index", "2147483647"],
        ["pointer-events", "none"],
    ];

    const CSS = `
        .wrap {
            display: flex;
            justify-content: center;
            padding: 0 16px 22px;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text",
                "Segoe UI", "Helvetica Neue", sans-serif;
        }

        .card {
            box-sizing: border-box;
            display: flex;
            align-items: center;
            gap: 13px;
            max-width: 420px;
            padding: 13px 18px 13px 15px;
            border-radius: 15px;
            background: rgba(255, 255, 255, 0.94);
            color: #1a1a1a;
            box-shadow:
                0 0 0 0.5px rgba(0, 0, 0, 0.07),
                0 10px 34px rgba(0, 0, 0, 0.2);
            -webkit-backdrop-filter: saturate(180%) blur(20px);
            backdrop-filter: saturate(180%) blur(20px);
            animation: frost-enter 260ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
        }

        .card.leaving {
            animation: frost-leave ${LEAVE_MS}ms ease-in both;
        }

        .badge {
            position: relative;
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            background: rgba(0, 122, 255, 0.12);
            color: #007aff;
        }

        .badge svg {
            width: 19px;
            height: 19px;
        }

        .ring {
            position: absolute;
            inset: 0;
            border: 2px solid currentColor;
            border-radius: 50%;
            animation: frost-pulse 1.9s ease-out infinite;
        }

        .text {
            min-width: 0;
        }

        .title {
            font-size: 13.5px;
            font-weight: 600;
            letter-spacing: -0.1px;
        }

        .detail {
            margin-top: 2px;
            font-size: 12.5px;
            line-height: 1.35;
            color: rgba(0, 0, 0, 0.55);
        }

        @keyframes frost-enter {
            from { opacity: 0; transform: translateY(14px) scale(0.97); }
            to { opacity: 1; transform: none; }
        }

        @keyframes frost-leave {
            to { opacity: 0; transform: translateY(8px); }
        }

        @keyframes frost-pulse {
            0% { transform: scale(0.82); opacity: 0.55; }
            70% { opacity: 0; }
            100% { transform: scale(1.45); opacity: 0; }
        }

        @media (prefers-color-scheme: dark) {
            .card {
                background: rgba(38, 38, 38, 0.94);
                color: #f5f5f5;
                box-shadow:
                    0 0 0 0.5px rgba(255, 255, 255, 0.08),
                    0 10px 34px rgba(0, 0, 0, 0.45);
            }

            .detail { color: rgba(255, 255, 255, 0.6); }

            .badge {
                background: rgba(10, 132, 255, 0.22);
                color: #0a84ff;
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .card, .card.leaving, .ring { animation: none; }
        }
    `;

    const SVG_NS = "http://www.w3.org/2000/svg";

    interface Toast {
        host: HTMLElement;
        card: HTMLDivElement;
        badge: HTMLDivElement;
        title: HTMLDivElement;
        detail: HTMLDivElement;
    }

    let toast: Toast | null = null;
    let nudgeTimer = 0;
    let leaveTimer = 0;

    /** Number of credential requests currently in flight. */
    let pending = 0;

    function div(parent: Node, className: string): HTMLDivElement {
        const element = window.document.createElement("div");
        element.className = className;
        parent.appendChild(element);
        return element;
    }

    function styleSheet(): CSSStyleSheet | null {
        // Constructed stylesheets are exempt from the page's `style-src` CSP,
        // which a `<style>` element is not. Keep the element as a fallback for
        // the (unlikely) case that construction fails.
        try {
            const sheet = new window.CSSStyleSheet();
            sheet.replaceSync(CSS);
            return sheet;
        } catch {
            return null;
        }
    }

    function build(): Toast {
        const host = window.document.createElement("frost-login-overlay");
        for (const [property, value] of HOST_STYLE) {
            host.style.setProperty(property, value, "important");
        }

        const root = host.attachShadow({ mode: "closed" });
        const sheet = styleSheet();
        if (sheet) {
            root.adoptedStyleSheets = [sheet];
        } else {
            const style = window.document.createElement("style");
            style.textContent = CSS;
            root.appendChild(style);
        }

        const wrap = div(root, "wrap");
        wrap.setAttribute("role", "status");
        wrap.setAttribute("aria-live", "polite");

        const card = div(wrap, "card");
        const badge = div(card, "badge");
        const text = div(card, "text");

        return {
            host,
            card,
            badge,
            title: div(text, "title"),
            detail: div(text, "detail"),
        };
    }

    function setIcon(badge: HTMLDivElement, name: IconName) {
        badge.textContent = "";

        const svg = window.document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.7");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");

        for (const path of ICONS[name]) {
            const element = window.document.createElementNS(SVG_NS, "path");
            element.setAttribute("d", path);
            svg.appendChild(element);
        }

        badge.appendChild(svg);
        div(badge, "ring");
    }

    function show(kind: Kind) {
        const copy = COPY[kind];
        const view = toast ?? (toast = build());

        if (!view.host.isConnected) {
            const root = window.document.body || window.document.documentElement;
            root.appendChild(view.host);
        }

        window.clearTimeout(leaveTimer);
        window.clearTimeout(nudgeTimer);
        view.card.classList.remove("leaving");

        setIcon(view.badge, copy.icon);
        view.title.textContent = copy.title;
        view.detail.textContent = copy.detail;

        nudgeTimer = window.setTimeout(() => {
            view.detail.textContent = copy.nudge;
        }, NUDGE_AFTER_MS);
    }

    function hide() {
        window.clearTimeout(nudgeTimer);

        const view = toast;
        if (!view || !view.host.isConnected) return;

        view.card.classList.add("leaving");
        leaveTimer = window.setTimeout(() => {
            if (view.host.isConnected) view.host.remove();
        }, LEAVE_MS);
    }

    function signal(state: "start" | "stop", kind: Kind | null) {
        try {
            window.console.info(SIGNAL + JSON.stringify({ state, kind }));
        } catch {
            // The page replaced `console`; the toast itself still works.
        }
    }

    function begin(kind: Kind) {
        pending += 1;
        show(kind);
        signal("start", kind);
    }

    function end() {
        pending = Math.max(0, pending - 1);
        if (pending > 0) return;
        hide();
        signal("stop", null);
    }

    function transportsOf(publicKey: { allowCredentials?: unknown }): string[] {
        const transports: string[] = [];
        if (!Array.isArray(publicKey.allowCredentials)) return transports;

        for (const descriptor of publicKey.allowCredentials as unknown[]) {
            const listed = (descriptor as { transports?: unknown } | null)
                ?.transports;
            if (!Array.isArray(listed)) continue;
            for (const transport of listed as unknown[]) {
                if (typeof transport !== "string") continue;
                if (!transports.includes(transport)) transports.push(transport);
            }
        }
        return transports;
    }

    /**
     * Work out what the page is waiting for, or null if it is something the
     * user is not expected to act on right now.
     */
    function classify(method: "get" | "create", options: unknown): Kind | null {
        if (!options || typeof options !== "object") return null;
        const request = options as CredentialOptions;

        // Conditional mediation ("passkey autofill") leaves a request pending
        // for as long as the page is open, waiting for the user to pick an
        // account from a form field. Nobody is being kept waiting, so a toast
        // insisting they touch something would be a lie.
        if (request.mediation === "conditional") return null;

        if (request.publicKey && typeof request.publicKey === "object") {
            const platform =
                request.publicKey.authenticatorSelection
                    ?.authenticatorAttachment === "platform";

            if (method === "create") {
                return platform ? "register-passkey" : "register-key";
            }

            // An allow-list naming only transports the user cannot plug in is
            // a passkey request; anything else — including a request with no
            // allow-list at all — can be answered by a key in a USB port,
            // which is the case that most needs explaining.
            const transports = transportsOf(request.publicKey);
            const roaming = transports.some((transport) =>
                ROAMING_TRANSPORTS.includes(transport)
            );
            return transports.length > 0 && !roaming
                ? "passkey"
                : "security-key";
        }

        if (request.otp) return "otp";
        if (request.password || request.federated || request.identity) {
            return "password";
        }
        return null;
    }

    type AnyCall = (this: unknown, ...args: unknown[]) => unknown;

    function patch(method: "get" | "create") {
        const container = credentials as unknown as Record<string, unknown>;
        const original = container[method];
        if (typeof original !== "function") return;
        const call = original as AnyCall;

        const wrapped = function (this: unknown, ...args: unknown[]): unknown {
            const kind = classify(method, args[0]);
            if (!kind) return call.apply(this, args);

            begin(kind);

            // Call through synchronously: WebAuthn requests are made from a
            // click handler and deferring would spend the user activation.
            let result: unknown;
            try {
                result = call.apply(this, args);
            } catch (err) {
                end();
                throw err;
            }

            const settled = result as PromiseLike<unknown> | null;
            if (!settled || typeof settled.then !== "function") {
                end();
                return result;
            }

            return settled.then(
                (value) => {
                    end();
                    return value;
                },
                (err: unknown) => {
                    end();
                    throw err;
                }
            );
        };

        try {
            container[method] = wrapped;
        } catch {
            // Frozen `navigator.credentials`: nothing to do but stay quiet and
            // leave the page working exactly as it did before.
        }
    }

    patch("get");
    patch("create");
})();
