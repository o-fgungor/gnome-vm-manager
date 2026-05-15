import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import Clutter from "gi://Clutter";
import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { VmIndicator } from "./src/indicator.js";
import { VmMenu } from "./src/menu.js";
import {
    getVirtualMachines,
    getVmLiveStats,
    getVmStartTimeMs,
    runVirshAction,
    startEventListener,
    stopEventListener,
} from "./src/virsh.js";
import { vmsChanged } from "./src/vmUtils.js";
import { resolveTerminalArgv } from "./src/terminal.js";

function _formatUptime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return "< 1m";
}

export default class VmManagerProExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._vms = [];
        this._actionInProgressCount = 0;
        this._indicator = new VmIndicator();
        this._indicator.menu.actor.add_style_class_name("vm-menu-container");
        this._menuBuilder = new VmMenu(this);

        this._panelClickId = this._indicator._box.connect("button-press-event", () => {
            this._buildMenuSafely();
            this._indicator.menu.toggle();
            return Clutter.EVENT_STOP;
        });

        const menuScrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            style_class: "vfade",
            overlay_scrollbars: true,
        });
        const menuBin = this._indicator.menu.actor.bin;
        menuBin.set_child(null);
        menuScrollView.add_child(this._indicator.menu.box);
        menuBin.set_child(menuScrollView);
        this._menuScrollView = menuScrollView;

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._menuOpenId = this._indicator.menu.connect("open-state-changed", (menu, isOpen) => {
            if (isOpen) {
                const monitor = Main.layoutManager.primaryMonitor;
                const maxH = monitor.height - Main.panel.height - 24;
                this._menuScrollView.style = `max-height: ${maxH}px;`;
                this._buildMenuSafely();
            } else {
                this._fetchVms();
            }
        });

        this._liveTimerId = null;
        this._liveTarget = null;
        this._vmStartTimes = new Map();
        this._ipRetryIds = new Map();

        // Defer initial fetch to avoid blocking GNOME Shell startup
        this._initTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._initTimeoutId = null;
            this._fetchVms().catch(() => {});
            this._startEventListener();
            this._startPolling(30);
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._initTimeoutId) {
            GLib.source_remove(this._initTimeoutId);
            this._initTimeoutId = null;
        }

        if (this._panelClickId) {
            this._indicator?._box.disconnect(this._panelClickId);
            this._panelClickId = null;
        }

        if (this._menuOpenId) {
            this._indicator?.menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }

        this._stopLiveStats();
        stopEventListener();
        this._clearAllIpRetries();

        if (this._restartTimerId) {
            GLib.source_remove(this._restartTimerId);
            this._restartTimerId = null;
        }
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        if (this._eventDebounceId) {
            GLib.source_remove(this._eventDebounceId);
            this._eventDebounceId = null;
        }
        
        this._indicator?.destroy();
        this._indicator = null;
        if (this._menuScrollView) {
            this._menuScrollView.destroy();
            this._menuScrollView = null;
        }
        this._menuBuilder = null;
        this._settings = null;
        this._vmStartTimes = null;
        this._ipRetryIds = null;
    }

    get _actionInProgress() {
        return this._actionInProgressCount > 0;
    }

    _startEventListener() {
        startEventListener(() => this._onVirshEvent(), () => this._onEventListenerDied());
    }

    _onEventListenerDied() {
        if (this._restartTimerId) return;
        this._restartTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._restartTimerId = null;
            this._startEventListener();
            this._startPolling(30);
            return GLib.SOURCE_REMOVE;
        });
    }

    _startPolling(seconds) {
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            if (!this._indicator.menu.isOpen) {
                this._fetchVms();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onVirshEvent() {
        if (this._eventDebounceId) GLib.source_remove(this._eventDebounceId);
        this._eventDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._eventDebounceId = null;
            this._fetchVms();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _fetchVms() {
        try {
            const vms = await getVirtualMachines();
            this._lastFetchError = null;
            const startTimePromises = [];

            for (const newVm of vms) {
                const oldVm = this._vms.find(v => v.name === newVm.name);
                if (oldVm && oldVm.details) newVm.details = oldVm.details;
                
                if (newVm.state === "running") {
                    if (!this._vmStartTimes.has(newVm.name)) {
                        startTimePromises.push(
                            getVmStartTimeMs(newVm.name).then(t => {
                                this._vmStartTimes.set(newVm.name, t ?? Date.now());
                            })
                        );
                    }
                } else {
                    this._vmStartTimes.delete(newVm.name);
                }
            }

            if (startTimePromises.length > 0) {
                await Promise.all(startTimePromises);
            }

            const changed = vmsChanged(this._vms, vms);
            this._vms = vms;
            this._updateIndicator();
            
            if (changed) {
                this._buildMenuSafely();
            }
            return vms;
        } catch (err) {
            console.error(`[VM Manager Pro] Fetch failed: ${err.message}`);
            if (this._lastFetchError !== err.message) {
                this._lastFetchError = err.message;
                Main.notify("VM Manager", `Failed to fetch VMs: ${err.message}`);
            }
            this._showError(err.message);
            throw err;
        }
    }

    _updateIndicator() {
        if (!this._indicator) return;
        const runningCount = this._vms.filter(vm => vm.state === "running").length;
        const pausedCount = this._vms.filter(vm => ["paused", "pmsuspended"].includes(vm.state)).length;
        const dangerCount = this._vms.filter(vm => vm.state === "crashed").length;
        this._indicator.update(runningCount, this._vms.length, pausedCount > 0, dangerCount > 0);
    }

    _buildMenuSafely() {
        try { 
            this._menuBuilder.build(); 
        } catch (e) { 
            console.error(`[VM Manager Pro] Build failed: ${e.message}`);
            this._showError(e.message); 
        }
    }

    _runAction(action, vmName, skipRefresh = false) {
        this._actionInProgressCount++;
        return runVirshAction(action, vmName)
            .then(() => {
                if (!skipRefresh) return this._fetchVms();
                return null;
            })
            .catch(err => {
                console.error(`[VM Manager Pro] Action failed: ${err.message}`);
                Main.notify("VM Manager", `${vmName}: Action failed: ${err.message}`);
                throw err;
            })
            .finally(() => {
                this._actionInProgressCount--;
            });
    }

    /**
     * Poll until all specified VMs reach the target state or timeout (60s).
     */
    async waitForVmsState(vmNames, targetState) {
        const start = Date.now();
        const timeout = 60000; 

        while (Date.now() - start < timeout) {
            const vms = await getVirtualMachines();
            const allMatch = vmNames.every(name => {
                const vm = vms.find(v => v.name === name);
                if (!vm) {
                    // If VM is not found in the list, we consider it 'shut off'
                    return targetState === "shut off";
                }
                return vm.state === targetState;
            });

            if (allMatch) return true;
            
            // Wait 2 seconds before next poll
            await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => { r(); return GLib.SOURCE_REMOVE; }));
        }
        throw new Error("Timeout waiting for VMs to change state");
    }

    _clearIpRetry(vmName) {
        const retryId = this._ipRetryIds?.get(vmName);
        if (!retryId) return;
        GLib.source_remove(retryId);
        this._ipRetryIds.delete(vmName);
    }

    _clearAllIpRetries() {
        if (!this._ipRetryIds) return;
        for (const retryId of this._ipRetryIds.values()) GLib.source_remove(retryId);
        this._ipRetryIds.clear();
    }

    _startLiveStats(vm, cpuItem, ramItem, uptimeItem) {
        this._stopLiveStats();
        this._liveTarget = { vm, cpuItem, ramItem, uptimeItem, prevCpu: null };
        this._doLiveUpdate();
        this._liveTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._doLiveUpdate();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLiveStats() {
        if (this._liveTimerId) { GLib.source_remove(this._liveTimerId); this._liveTimerId = null; }
        this._liveTarget = null;
    }

    _doLiveUpdate() {
        const target = this._liveTarget;
        if (!target) return;

        if (target.uptimeItem) {
            const startTime = this._vmStartTimes?.get(target.vm.name);
            if (startTime) target.uptimeItem.label.text = `Up: ${_formatUptime(Date.now() - startTime)}`;
        }

        getVmLiveStats(target.vm.name)
            .then(stats => {
                if (this._liveTarget !== target) return;
                const now = Date.now();
                if (target.prevCpu && stats.cpuTimeNs != null) {
                    const cpuDelta = stats.cpuTimeNs - target.prevCpu.timeNs;
                    const wallDeltaNs = (now - target.prevCpu.wallMs) * 1_000_000;
                    const numCpus = parseInt(target.vm.details?.cpus ?? "1") || 1;
                    const pct = Math.min(100, Math.round(cpuDelta / wallDeltaNs / numCpus * 100));
                    target.cpuItem.label.text = `CPU: ${target.vm.details?.cpus ?? "\u2014"} \u00b7 ${pct}%`;
                }
                if (stats.cpuTimeNs != null) target.prevCpu = { timeNs: stats.cpuTimeNs, wallMs: now };
            })
            .catch(() => {});
    }

    _openSsh(vmName, username, ip) {
        const saved = this._settings.get_value("ssh-usernames").deep_unpack();
        saved[vmName] = username;
        this._settings.set_value("ssh-usernames", new GLib.Variant("a{ss}", saved));

        try {
            const sshCmd = `ssh ${username}@${ip}`;
            // Wrap in bash to keep terminal open if SSH fails or disconnects
            const bashWrapper = `${sshCmd} || (echo; echo '---------------------------------------'; echo 'Connection failed or disconnected.'; echo 'Press Enter to close this terminal...'; read)`;
            const argv = resolveTerminalArgv(this._settings, ["bash", "-c", bashWrapper]);
            
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            this._indicator.menu.close();
        } catch (e) { this._showError(`Failed to open terminal: ${e.message}`); }
    }

    _showError(message) {
        if (!this._indicator) return;
        const menu = this._indicator.menu;
        menu.removeAll();
        const item = new PopupMenu.PopupMenuItem(`Error: ${message}`, { reactive: false });
        item.label.clutter_text.line_wrap = true;
        menu.addMenuItem(item);
    }
}
