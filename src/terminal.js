import GLib from "gi://GLib";

export const TERMINAL_PROFILES = [
    { id: "auto", label: "Auto (Recommended)" },
    { id: "gnome-terminal", label: "GNOME Terminal" },
    { id: "ghostty", label: "Ghostty" },
    { id: "kitty", label: "Kitty" },
    { id: "xterm", label: "XTerm" },
    { id: "custom", label: "Custom" },
];

const PROFILE_DEFS = {
    "gnome-terminal": {
        label: "GNOME Terminal",
        executable: "gnome-terminal",
        buildArgv(commandArgv) {
            return ["gnome-terminal", "--", ...commandArgv];
        },
    },
    ghostty: {
        label: "Ghostty",
        executable: "ghostty",
        buildArgv(commandArgv) {
            return ["ghostty", "-e", ...commandArgv];
        },
    },
    kitty: {
        label: "Kitty",
        executable: "kitty",
        buildArgv(commandArgv) {
            return ["kitty", ...commandArgv];
        },
    },
    xterm: {
        label: "XTerm",
        executable: "xterm",
        buildArgv(commandArgv) {
            return ["xterm", "-e", ...commandArgv];
        },
    },
};

const AUTO_PROFILE_IDS = [
    "gnome-terminal",
    "ghostty",
    "kitty",
    "xterm",
];

export function getEffectiveTerminalProfile(settings) {
    const storedProfile = settings.get_string("terminal-profile").trim();
    if (storedProfile)
        return storedProfile;

    const legacyCustomCommand = settings.get_string("terminal").trim();
    return legacyCustomCommand ? "custom" : "auto";
}

export function resolveTerminalArgv(settings, commandArgv) {
    const profile = getEffectiveTerminalProfile(settings);

    if (profile === "custom") {
        const customCommand = settings.get_string("terminal").trim();
        if (!customCommand) {
            throw new Error("No custom terminal command set. Open Settings to configure one.");
        }

        const [, terminalArgv] = GLib.shell_parse_argv(customCommand);
        return [...terminalArgv, ...commandArgv];
    }

    if (profile === "auto") {
        for (const candidateId of AUTO_PROFILE_IDS) {
            const def = PROFILE_DEFS[candidateId];
            if (GLib.find_program_in_path(def.executable))
                return def.buildArgv(commandArgv);
        }

        throw new Error("No supported terminal found. Open Settings and choose one.");
    }

    const def = PROFILE_DEFS[profile];
    if (!def)
        throw new Error(`Unknown terminal profile: ${profile}`);

    if (!GLib.find_program_in_path(def.executable)) {
        throw new Error(`${def.label} is not installed. Open Settings and choose another terminal.`);
    }

    return def.buildArgv(commandArgv);
}
