/**
 * Renders an Electron accelerator the way the current platform writes
 * shortcuts, for notification bodies and anywhere else we show the user their
 * refresh hotkey.
 *
 * macOS stacks modifier glyphs with no separator (`⌘⇧R`); Windows and Linux
 * spell the modifiers out and join them with `+` (`Ctrl+Shift+R`). The same
 * logic is mirrored in `fmtHotkey()` in `src/dashboard.html`, which cannot
 * import from here — keep the two in step.
 */

const MAC_SYMBOLS: Record<string, string> = {
    CommandOrControl: "⌘",
    CmdOrCtrl: "⌘",
    Command: "⌘",
    Cmd: "⌘",
    Control: "⌃",
    Ctrl: "⌃",
    Option: "⌥",
    Alt: "⌥",
    Shift: "⇧",
    Super: "⌘",
    Meta: "⌘",
};

const PC_NAMES: Record<string, string> = {
    CommandOrControl: "Ctrl",
    CmdOrCtrl: "Ctrl",
    Command: "Win",
    Cmd: "Win",
    Control: "Ctrl",
    Option: "Alt",
    Super: "Win",
    Meta: "Win",
};

export function formatHotkey(accelerator: string): string {
    const parts = String(accelerator || "").split("+");

    if (process.platform === "darwin") {
        return parts.map((part) => MAC_SYMBOLS[part] ?? part).join("");
    }

    return parts.map((part) => PC_NAMES[part] ?? part).join("+");
}
