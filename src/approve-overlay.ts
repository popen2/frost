/**
 * The approval driver Frost injects into its AWS SSO login window.
 *
 * The device authorization flow AWS SSO uses is a *multi-step* approval: the
 * page opened from `verificationUriComplete` asks to confirm the request
 * ("Confirm and continue"), then — once the user has an identity provider
 * session — asks to grant access ("Allow access"), and only then is the device
 * code redeemable. None of those steps carry information the user has to
 * supply: with a live federated session they are two clicks on two pages that
 * say what they are going to do next. This script performs those clicks so the
 * common refresh needs nothing from the user at all, and reports back the
 * moment the page asks for something only the user can give — a password, a
 * one-time code — so `src/auto-approve.ts` can put the window on screen.
 *
 * Like `src/login-overlay.ts`, this runs **in the browser**, in the page's own
 * world, on pages Frost does not control, and it is compiled on its own by
 * `tsconfig.overlay.json` and injected as source text. Read the header of that
 * file for what the compile has to look like and why. The rules that matter
 * here:
 *
 * -   It only ever clicks on an AWS SSO device-authorization host, and only a
 *     control it recognises by id or by exact label. Anything else — a page it
 *     cannot read, a button AWS renamed — is left alone, and the wait that
 *     follows is what shows the window. Guessing wrong is worse than stalling:
 *     the buttons next to the ones we want revoke access or cancel the request.
 * -   It never clicks a control whose label reads like a refusal, whatever its
 *     id says.
 * -   It reports over the console (see `SIGNAL`), the only channel a script in
 *     the page's world has. The page can forge those lines, so nothing here may
 *     ever be security-relevant: the worst a forged line can do is show the
 *     login window that was about to be shown anyway.
 */
(() => {
    "use strict";

    const FLAG = "__frostApproveOverlay";

    /** The page's globals are not typed for our own bookkeeping. */
    const flags = window as unknown as Record<string, boolean | undefined>;
    if (flags[FLAG]) return;
    flags[FLAG] = true;

    /** Must match APPROVE_SIGNAL in src/auto-approve.ts. */
    const SIGNAL = "__frost-login-approve__:";

    /** How often the page is re-examined. */
    const SCAN_MS = 400;

    /** Quiet period after a click, so a re-render is not clicked twice. */
    const AFTER_CLICK_MS = 1500;

    /**
     * A page needing more clicks than this is not the flow we know. Stopping
     * leaves the window to the stall timer in the main process, which is the
     * safe outcome; carrying on would be a script clicking around a page it has
     * evidently misread.
     */
    const MAX_CLICKS = 4;

    /** Nothing in this flow takes minutes; stop scanning rather than spin. */
    const MAX_LIFETIME_MS = 180000;

    /**
     * Hosts serving the device-authorization pages: the account's own portal
     * (`d-1234567890.awsapps.com`, `acme.awsapps.com`) and the regional device
     * endpoint. Clicking happens nowhere else — an identity provider's pages
     * are the user's to answer.
     */
    function isApprovalHost(hostname: string): boolean {
        const host = hostname.toLowerCase();
        return (
            host === "awsapps.com" ||
            host.endsWith(".awsapps.com") ||
            /^device\.sso\.[a-z0-9-]+\.amazonaws\.com$/.test(host) ||
            /^oidc\.[a-z0-9-]+\.amazonaws\.com$/.test(host)
        );
    }

    /** Ids AWS has used for the two approval buttons. */
    const APPROVAL_IDS = ["cli_verification_btn", "cli_login_button"];

    /** Exact labels — a partial match is how you end up clicking "Deny". */
    const APPROVAL_LABELS = [
        "confirm and continue",
        "allow access",
        "allow",
        "approve",
        "authorize",
        "accept",
        "confirm",
        "yes, allow",
    ];

    const DENY_WORDS = [
        "cancel",
        "deny",
        "reject",
        "decline",
        "no",
        "close",
        "back",
        "logout",
        "revoke",
    ];

    const DENY_PHRASES = ["sign out", "log out", "not now", "try another"];

    /** The page the flow ends on. Its text is the only "we are done" we get. */
    const APPROVED_TEXTS = [
        "request approved",
        "you can close this window",
        "you may close this window",
        "you can now close this window",
    ];

    const CONTROL_SELECTOR =
        'button, input[type="submit"], input[type="button"], [role="button"]';

    /** Input types the user is expected to type into. */
    const TYPED_INPUT_TYPES = ["", "text", "email", "tel", "number", "search", "url"];

    function normalize(text: string | null | undefined): string {
        return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    /**
     * What the control says it does, as the user would read it: its accessible
     * label, else its text, else the value a submit button renders.
     */
    function labelOf(element: Element): string {
        const aria = normalize(element.getAttribute("aria-label"));
        if (aria) return aria;

        const text = normalize(element.textContent);
        if (text) return text;

        const value = (element as HTMLInputElement).value;
        return normalize(typeof value === "string" ? value : "");
    }

    function isDenial(label: string): boolean {
        const words = label.split(/[^a-z0-9]+/).filter(Boolean);
        return (
            words.some((word) => DENY_WORDS.indexOf(word) >= 0) ||
            DENY_PHRASES.some((phrase) => label.indexOf(phrase) >= 0)
        );
    }

    /**
     * `checkVisibility` is preferred over measuring a rectangle because this
     * runs in a window that has not been shown yet: it answers from styles
     * rather than from layout, so it does not depend on the window ever having
     * been painted. The measurement below is the fallback for a page whose
     * engine predates it.
     */
    function isVisible(element: Element): boolean {
        if (typeof element.checkVisibility === "function") {
            try {
                return element.checkVisibility({
                    checkOpacity: true,
                    checkVisibilityCSS: true,
                });
            } catch {
                // Fall through to the measured answer.
            }
        }

        const rect = element.getBoundingClientRect();
        if (rect.width < 1 && rect.height < 1) return false;

        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none";
    }

    function isEnabled(element: Element): boolean {
        if ((element as HTMLButtonElement).disabled) return false;
        return element.getAttribute("aria-disabled") !== "true";
    }

    const clicked = new WeakSet<Element>();
    let clicks = 0;

    function isApproval(element: Element): boolean {
        if (clicked.has(element)) return false;
        if (!isEnabled(element) || !isVisible(element)) return false;

        const label = labelOf(element);
        if (isDenial(label)) return false;

        if (APPROVAL_IDS.indexOf(element.id) >= 0) return true;
        return APPROVAL_LABELS.indexOf(label) >= 0;
    }

    /**
     * The control to click, or null. Ids win over labels: an id is AWS's own
     * handle on the button, while a label match could in principle be some
     * other control that happens to read the same way.
     */
    function approvalControl(): HTMLElement | null {
        const controls = Array.prototype.slice.call(
            window.document.querySelectorAll(CONTROL_SELECTOR)
        ) as HTMLElement[];

        let byLabel: HTMLElement | null = null;
        for (const control of controls) {
            if (!isApproval(control)) continue;
            if (APPROVAL_IDS.indexOf(control.id) >= 0) return control;
            if (!byLabel) byLabel = control;
        }
        return byLabel;
    }

    /**
     * Why the page cannot go on without the user, or null. An empty field the
     * user has to fill in is the signal; the device page's own code field
     * arrives already filled from `verificationUriComplete`, which is exactly
     * the difference that matters.
     */
    function userPrompt(): string | null {
        const fields = Array.prototype.slice.call(
            window.document.querySelectorAll("input, textarea")
        ) as HTMLInputElement[];

        for (const field of fields) {
            if (field.disabled || field.readOnly) continue;

            const isTextArea = field.tagName === "TEXTAREA";
            const type = normalize(field.getAttribute("type"));
            if (!isTextArea) {
                if (type === "hidden") continue;
                if (type === "password") {
                    if (isVisible(field)) return "password";
                    continue;
                }
                if (TYPED_INPUT_TYPES.indexOf(type) < 0) continue;
            }

            if (normalize(field.value)) continue;
            if (isVisible(field)) return "input";
        }
        return null;
    }

    function isApproved(): boolean {
        const body = window.document.body;
        const text = normalize(body ? body.innerText : "");
        if (!text) return false;
        return APPROVED_TEXTS.some((phrase) => text.indexOf(phrase) >= 0);
    }

    function signal(payload: Record<string, string>) {
        try {
            window.console.info(SIGNAL + JSON.stringify(payload));
        } catch {
            // The page replaced `console`. Nothing is reported, and the main
            // process falls back to showing the window when it stops hearing
            // about progress - which is the same outcome as a page we cannot
            // drive at all.
        }
    }

    let timer = 0;
    let pausedUntil = 0;
    let reported = false;
    const startedAt = Date.now();

    function stop() {
        window.clearInterval(timer);
    }

    function scan() {
        const now = Date.now();
        if (now < pausedUntil) return;
        if (now - startedAt > MAX_LIFETIME_MS) {
            stop();
            return;
        }
        if (!window.document.body) return;

        if (isApprovalHost(window.location.hostname)) {
            if (isApproved()) {
                signal({ state: "approved" });
                stop();
                return;
            }

            const control = approvalControl();
            if (control && clicks < MAX_CLICKS) {
                clicks += 1;
                clicked.add(control);
                pausedUntil = now + AFTER_CLICK_MS;

                const label = labelOf(control) || control.id;
                signal({ state: "clicked", label });
                try {
                    control.click();
                } catch {
                    // A control that will not take a click is a page we cannot
                    // drive; the wait that follows shows the window.
                }
                return;
            }
        }

        // Kept running after the first report: once the user has signed in, the
        // remaining approval steps are ours to click again.
        if (!reported) {
            const prompt = userPrompt();
            if (prompt) {
                reported = true;
                signal({ state: "user", reason: prompt });
            }
        }
    }

    timer = window.setInterval(scan, SCAN_MS);
    scan();
})();
