import * as Main from "resource:///org/gnome/shell/ui/main.js";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Pango from "gi://Pango";
import GLib from "gi://GLib";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { runVirshAction, getVmDetails, toggleAutoStart } from "./virsh.js";
import { getActionsForState, getQuickActionForState } from "./vmUtils.js";

export class VmMenu {
    constructor(extension) {
        this._ext = extension;
        this._bulkActionResetters = [];
        this._bgClickId = null;
    }

    build() {
        this._ext._stopLiveStats();
        this._ext._clearAllIpRetries();
        this._bulkActionResetters = [];
        const menu = this._ext._indicator.menu;
        menu.removeAll();

        if (!this._bgClickId) {
            menu.box.reactive = true;
            this._bgClickId = menu.box.connect("button-press-event", () => {
                this.resetBulkActions();
                return Clutter.EVENT_PROPAGATE;
            });
        }

        if (this._ext._vms.length === 0) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem("No virtual machines found", { reactive: false }));
            return;
        }

        // VMs don't have groups like Docker Compose projects yet, so we always use flat menu.
        this._buildFlatMenu(menu, this._ext._vms);
        this._addBulkActions(menu);
    }

    resetBulkActions() {
        this._bulkActionResetters.forEach(reset => reset());
    }

    _buildFlatMenu(menu, vms) {
        const running = vms.filter(vm => vm.state === "running");
        const others = vms.filter(vm => vm.state !== "running");
        for (const vm of running) this._addVmMenuItem(menu, vm);
        for (const vm of others) this._addVmMenuItem(menu, vm);
    }

    _addBulkActions(menu, projectName = "", vms = this._ext._vms) {
        const stopped = vms.filter(vm => vm.state !== "running");
        const running = vms.filter(vm => vm.state === "running");
        const isGlobal = projectName === "";
        if (vms.length === 0) return;
        if (isGlobal) menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const row = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const box = new St.BoxLayout({ x_expand: true, x_align: Clutter.ActorAlign.CENTER, style: "spacing: 12px; padding: 4px 0;" });

        const makeBtn = (text, onClick) => {
            const btn = new St.Button({ style_class: "popup-menu-item vm-submenu-button", x_expand: true, can_focus: true });
            btn.set_child(new St.Label({ text, x_align: Clutter.ActorAlign.CENTER }));

            let confirmed = false;
            let loading = false;

            const resetBtn = () => {
                confirmed = false;
                btn.get_child().text = text;
                btn.remove_style_class_name("confirm-start-all");
                btn.remove_style_class_name("confirm-stop-all");
                btn.reactive = true;
            };
            this._bulkActionResetters.push(resetBtn);

            btn.connect("clicked", () => {
                if (loading) return;
                
                if (!confirmed) {
                    this.resetBulkActions();
                    confirmed = true;
                    btn.get_child().text = "Are you sure?";
                    btn.add_style_class_name(text.startsWith("Start") ? "confirm-start-all" : "confirm-stop-all");
                    return;
                }

                loading = true;
                const originalText = text;
                const actionVerb = originalText.startsWith("Start") ? "Starting" : "Stopping";
                btn.get_child().text = `${actionVerb}...`;
                btn.reactive = false; 
                
                onClick().then(() => {
                    btn.get_child().text = "Done!";
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                        if (btn.get_child()) {
                            resetBtn();
                            loading = false;
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }).catch(err => {
                    btn.get_child().text = "Failed!";
                    btn.reactive = true;
                    loading = false;
                    confirmed = false;
                });
            });

            const menuId = this._ext._indicator.menu.connect("open-state-changed", (m, isOpen) => {
                if (!isOpen && !loading) resetBtn();
            });
            btn.connect("destroy", () => this._ext._indicator.menu.disconnect(menuId));
            return btn;
        };

        if (stopped.length > 0) box.add_child(makeBtn(isGlobal ? "Start All" : "Start Group", () => {
            const names = stopped.map(vm => vm.name);
            this._ext._actionInProgressCount++;
            return Promise.all(names.map(name => this._ext._runAction("start", name, true)))
                .then(() => this._ext.waitForVmsState(names, "running"))
                .then(() => this._ext._fetchVms())
                .finally(() => { this._ext._actionInProgressCount--; });
        }));
        if (running.length > 0) box.add_child(makeBtn(isGlobal ? "Stop All" : "Stop Group", () => {
            const names = running.map(vm => vm.name);
            this._ext._actionInProgressCount++;
            return Promise.all(names.map(name => this._ext._runAction("shutdown", name, true)))
                .then(() => this._ext.waitForVmsState(names, "shut off"))
                .then(() => this._ext._fetchVms())
                .finally(() => { this._ext._actionInProgressCount--; });
        }));

        row.add_child(box);
        menu.addMenuItem(row);
    }

    _addVmMenuItem(menu, vm) {
        const isRunning = vm.state === "running";
        const stateClass = this._getStateClass(vm.state);
        const quickAction = getQuickActionForState(vm.state);
        const item = new PopupMenu.PopupSubMenuMenuItem("");
        item.add_style_class_name("vm-toggle-item");
        menu.addMenuItem(item);
        item.reactive = false;
        item.remove_all_children();

        const toggleRow = new St.BoxLayout({ style_class: "vm-toggle-row quick-menu-toggle", x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const mainBtn = new St.Button({ style_class: `quick-toggle button ${stateClass}`, x_expand: true, can_focus: true });
        if (isRunning) mainBtn.add_style_pseudo_class("checked");
        if (quickAction) mainBtn.add_style_class_name("vm-has-quick-action");
        
        const mainContent = new St.BoxLayout({ x_expand: true, style_class: "vm-main-content" });
        
        const disclosureIcon = new St.Icon({ icon_name: "pan-end-symbolic", icon_size: 14, style_class: "vm-disclosure-icon" });
        disclosureIcon.set_pivot_point(0.5, 0.5);
        mainContent.add_child(disclosureIcon);

        const nameLabel = new St.Label({ 
            text: vm.name, 
            style_class: "vm-name-label", 
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        nameLabel.clutter_text.width_chars = 18; 
        mainContent.add_child(nameLabel);
        
        mainBtn.set_child(mainContent);
        mainBtn.connect("clicked", () => item.menu.toggle());
        toggleRow.add_child(mainBtn);

        if (quickAction) {
            const actionBtn = new St.Button({ style_class: `vm-quick-action quick-toggle button ${stateClass}`, label: quickAction.label, can_focus: true });
            if (isRunning) actionBtn.add_style_pseudo_class("checked");
            actionBtn.connect("clicked", () => this._ext._runAction(quickAction.action, vm.name));
            toggleRow.add_child(actionBtn);
        }
        item.add_child(toggleRow);

        const submenu = item.menu;
        submenu.actor.add_style_class_name("vm-submenu");
        
        const cpuItem = this._createDetailItem("CPU: \u2014"); submenu.addMenuItem(cpuItem);
        const uptimeItem = isRunning ? this._createDetailItem("Up: \u2014") : null;
        if (uptimeItem) submenu.addMenuItem(uptimeItem);
        const ramItem = this._createDetailItem("RAM: \u2014"); submenu.addMenuItem(ramItem);
        const diskItem = this._createDetailItem("Disk: \u2014"); submenu.addMenuItem(diskItem);
        const ipItem = isRunning ? this._createDetailItem("IP: \u2014") : null;
        if (ipItem) submenu.addMenuItem(ipItem);
        
        const sshUserItem = this._createSshUserItem(vm);
        submenu.addMenuItem(sshUserItem);

        submenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const sshItem = isRunning ? this._createActionButton("SSH", () => {
            const defaultUser = this._ext._settings.get_string("ssh-default-user") || GLib.get_user_name();
            const savedUsers = this._ext._settings.get_value("ssh-usernames").deep_unpack();
            const username = savedUsers[vm.name] || defaultUser;
            const ip = vm.details?.ip;
            if (ip) this._ext._openSsh(vm.name, username, ip);
            else Main.notify("VM Manager", `${vm.name}: IP address not available yet.`);
        }) : null;
        
        if (sshItem) { sshItem.actor.hide(); submenu.addMenuItem(sshItem); }

        const applyDetails = (details) => {
            cpuItem.label.text = `CPU: ${details.cpus ?? "\u2014"}`;
            ramItem.label.text = `RAM: ${details.memoryGb ? `${details.memoryGb} GB` : "\u2014"}`;
            diskItem.label.text = details.disk ? `Disk: ${details.disk.usedGb} / ${details.disk.totalGb} GB` : "Disk: \u2014";
            if (ipItem) ipItem.label.text = `IP: ${details.ip ?? "\u2014"}`;
            if (sshItem) { if (details.ip) sshItem.actor.show(); else sshItem.actor.hide(); }
        };

        const updateDetails = () => {
            const needsIp = isRunning && (!vm.details || !vm.details.ip);
            if (vm.details && !needsIp) {
                applyDetails(vm.details);
            } else {
                getVmDetails(vm.name, isRunning)
                    .then(details => {
                        vm.details = details;
                        applyDetails(details);
                        if (isRunning && !details.ip && item.menu.isOpen) {
                            this._ext._clearIpRetry(vm.name);
                            const retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                                this._ext._ipRetryIds?.delete(vm.name);
                                if (this._ext._indicator && item.menu.isOpen) updateDetails();
                                return GLib.SOURCE_REMOVE;
                            });
                            this._ext._ipRetryIds.set(vm.name, retryId);
                        }
                    })
                    .catch(err => { cpuItem.label.text = `Error: ${err.message}`; });
            }
        };

        submenu.connect("open-state-changed", (m, isOpen) => {
            disclosureIcon.ease({ rotation_angle_z: isOpen ? 90 : 0, duration: 140 });
            if (isOpen) {
                this.resetBulkActions();
                updateDetails();
                if (isRunning) this._ext._startLiveStats(vm, cpuItem, ramItem, uptimeItem);
            } else {
                this._ext._clearIpRetry(vm.name);
                this._ext._stopLiveStats();
            }
        });

        for (const { label, action } of getActionsForState(vm.state))
            submenu.addMenuItem(this._createActionButton(label, () => this._ext._runAction(action, vm.name)));

        submenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        submenu.addMenuItem(this._createAutostartMenuItem(vm));
    }

    _createDetailItem(text) {
        const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        item.add_style_class_name("vm-detail-item");
        
        const label = item.label.clutter_text;
        label.ellipsize = Pango.EllipsizeMode.NONE;
        label.line_wrap = true;
        
        item.label.x_expand = true;
        label.width = 10; 

        return item;
    }

    _createSshUserItem(vm) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        item.add_style_class_name("vm-detail-item");
        
        const label = new St.Label({ 
            text: "SSH User:", 
            y_align: Clutter.ActorAlign.CENTER,
            style: "margin-right: 8px;"
        });
        item.add_child(label);

        const entry = new St.Entry({
            hint_text: "default",
            can_focus: true,
            x_expand: true,
            style_class: "vm-ssh-user-entry"
        });
        
        const savedUsers = this._ext._settings.get_value("ssh-usernames").deep_unpack();
        entry.set_text(savedUsers[vm.name] || "");

        const save = () => {
            const username = entry.get_text().trim();
            const saved = this._ext._settings.get_value("ssh-usernames").deep_unpack();
            if (username) {
                saved[vm.name] = username;
            } else {
                delete saved[vm.name];
            }
            this._ext._settings.set_value("ssh-usernames", new GLib.Variant("a{ss}", saved));
        };

        entry.clutter_text.connect("activate", () => {
            save();
            entry.get_stage()?.set_key_focus(null);
        });

        entry.clutter_text.connect("key-focus-out", () => {
            save();
        });

        item.add_child(entry);
        return item;
    }

    _createActionButton(label, onClick) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        item.add_style_class_name("vm-action-item");
        const button = new St.Button({ style_class: "popup-menu-item vm-submenu-button", x_expand: true, can_focus: true });
        button.set_child(new St.Label({ text: label, style_class: "vm-submenu-button-label" }));
        button.connect("clicked", onClick);
        item.add_child(button);
        return item;
    }

    _createAutostartMenuItem(vm) {
        const item = new PopupMenu.PopupSwitchMenuItem("Autostart", vm.autostart);
        item.add_style_class_name("vm-action-item");
        item.add_style_class_name("vm-autostart-item");
        item.label?.add_style_class_name("vm-autostart-label");
        item.activate = function () { this.toggle(); };

        let enabled = vm.autostart;
        let syncing = false;
        let busy = false;

        const syncSwitch = () => { syncing = true; item.setToggleState(enabled); syncing = false; };

        item.connect("toggled", (it, state) => {
            if (syncing || busy) return;
            busy = true;
            item.reactive = false;
            item.can_focus = false;

            toggleAutoStart(vm.name, state)
                .then(() => { enabled = state; vm.autostart = state; syncSwitch(); })
                .catch(err => { syncSwitch(); this._ext._showError(`${vm.name}: ${err.message}`); })
                .finally(() => { busy = false; item.reactive = true; item.can_focus = true; });
        });
        return item;
    }

    _getStateClass(state) {
        switch (state) {
            case "running": return "vm-running";
            case "paused":
            case "pmsuspended": return "vm-paused";
            case "crashed": return "vm-crashed";
            default: return "vm-stopped";
        }
    }
}
