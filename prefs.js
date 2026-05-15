import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import GLib from "gi://GLib";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import { TERMINAL_PROFILES, getEffectiveTerminalProfile } from "./src/terminal.js";

export default class VmManagerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: "VM Manager",
            icon_name: "computer-symbolic",
        });
        window.add(page);

        // --- SSH group ---
        const sshGroup = new Adw.PreferencesGroup({
            title: "SSH",
            description: "Settings for opening SSH connections to virtual machines",
        });
        page.add(sshGroup);

        const terminalModel = Gtk.StringList.new(
            TERMINAL_PROFILES.map((profile) => profile.label),
        );
        const selectedProfile = getEffectiveTerminalProfile(settings);
        const selectedIndex = Math.max(
            0,
            TERMINAL_PROFILES.findIndex((profile) => profile.id === selectedProfile),
        );

        const terminalProfileRow = new Adw.ComboRow({
            title: "Terminal",
            model: terminalModel,
            subtitle: "Choose a terminal preset, or use Custom for your own command",
        });
        terminalProfileRow.set_selected(selectedIndex);
        sshGroup.add(terminalProfileRow);

        const terminalRow = new Adw.EntryRow({
            title: "Custom terminal command",
        });
        terminalRow.set_text(settings.get_string("terminal"));
        terminalRow.set_visible(selectedProfile === "custom");
        terminalRow.connect("changed", () => {
            settings.set_string("terminal", terminalRow.get_text());
        });
        const terminalHint = new Gtk.Label({
            label: 'Examples: gnome-terminal --   ghostty -e   kitty',
            css_classes: ["dim-label", "caption"],
            halign: Gtk.Align.START,
        });
        terminalRow.add_suffix(terminalHint);
        sshGroup.add(terminalRow);

        terminalProfileRow.connect("notify::selected", () => {
            const profile = TERMINAL_PROFILES[terminalProfileRow.get_selected()].id;
            settings.set_string("terminal-profile", profile);
            terminalRow.set_visible(profile === "custom");
        });

        // Default SSH user row
        const defaultUser = settings.get_string("ssh-default-user") ||
            GLib.get_user_name();
        const userRow = new Adw.EntryRow({
            title: "Default SSH username",
        });
        userRow.set_text(defaultUser);
        userRow.connect("changed", () => {
            settings.set_string("ssh-default-user", userRow.get_text());
        });
        sshGroup.add(userRow);
    }
}
