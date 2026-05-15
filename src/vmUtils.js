/**
 * Parse the tabular output of `virsh list --all`.
 */
export function parseVirshOutput(output) {
    if (!output || !output.trim()) return [];
    const lines = output.trim().split("\n");
    const vms = [];

    // Skip header (line 0) and separator (line 1)
    for (let i = 2; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;

        const name = parts[1];
        const state = parts.slice(2).join(" ");

        vms.push({ name, state });
    }

    return vms;
}

/**
 * Parse output of `virsh dominfo`.
 */
export function parseDomInfo(output) {
    if (!output) return {};
    const lines = output.trim().split("\n");
    const info = {};

    for (const line of lines) {
        const [key, ...valueParts] = line.split(":");
        if (!key || valueParts.length === 0) continue;

        const k = key.trim().toLowerCase();
        const v = valueParts.join(":").trim();

        if (k === "cpu(s)") {
            info.cpus = v;
        } else if (k === "used memory" || k === "max memory") {
            if (!info.memoryGb || k === "used memory") {
                const match = v.match(/^([\d.]+)\s*([a-zA-Z]+)?/);
                if (match) {
                    const val = parseFloat(match[1]);
                    const unit = (match[2] || "KiB").toLowerCase();
                    
                    let kib = val;
                    if (unit.startsWith("mi")) kib = val * 1024;
                    else if (unit.startsWith("gi")) kib = val * 1024 * 1024;
                    else if (unit.startsWith("ti")) kib = val * 1024 * 1024 * 1024;
                    
                    info.memoryGb = (kib / 1024 / 1024).toFixed(1);
                }
            }
        }
    }

    return info;
}

/**
 * Parse output of `virsh domifaddr`.
 */
export function parseDomIfAddr(output) {
    if (!output || !output.trim()) return null;
    const lines = output.trim().split("\n");

    for (let i = 2; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 4) continue;

        const protocol = parts[2].toLowerCase();
        const addressWithMask = parts[3];

        if (protocol === "ipv4") {
            return addressWithMask.split("/")[0];
        }
    }

    return null;
}

/**
 * Parse output of `virsh domstats --cpu-total --balloon`.
 */
export function parseDomStats(output, nowSec = Math.floor(Date.now() / 1000)) {
    if (!output || !output.trim()) return { cpuTimeNs: null };

    let cpuTimeNs = null;
    let balloonCurrentKib = null;
    let memAvailableKib = null;
    let balloonLastUpdate = null;

    for (const line of output.trim().split("\n")) {
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;

        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();

        if (key === "cpu.time") cpuTimeNs = Number(val);
        else if (key === "balloon.current") balloonCurrentKib = Number(val);
        else if (key === "balloon.available") memAvailableKib = Number(val);
        else if (key === "balloon.last-update") balloonLastUpdate = Number(val);
    }

    const result = { cpuTimeNs };
    const isRecent = balloonLastUpdate != null && (nowSec - balloonLastUpdate) <= 10;
    if (isRecent && balloonCurrentKib > 0 && memAvailableKib != null && memAvailableKib > 0) {
        result.memUsedKib = balloonCurrentKib - memAvailableKib;
        result.memTotalKib = balloonCurrentKib;
    }

    return result;
}

/**
 * Parse output of `virsh domblkinfo --all`.
 */
export function parseDomBlkInfo(output) {
    if (!output || !output.trim()) return null;

    const lines = output.trim().split("\n");
    let totalBytes = 0;
    let usedBytes = 0;

    for (let i = 2; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;

        const capacity = parseInt(parts[1]);
        const allocation = parseInt(parts[2]);

        if (!isNaN(capacity)) totalBytes += capacity;
        if (!isNaN(allocation)) usedBytes += allocation;
    }

    if (totalBytes === 0) return null;

    return {
        usedGb: (usedBytes / 1024 / 1024 / 1024).toFixed(1),
        totalGb: (totalBytes / 1024 / 1024 / 1024).toFixed(1),
    };
}

/**
 * Compare old and new VM lists.
 */
export function vmsChanged(oldVms, newVms) {
    if (oldVms.length !== newVms.length) return true;
    for (let i = 0; i < oldVms.length; i++) {
        if (
            oldVms[i].name !== newVms[i].name ||
            oldVms[i].state !== newVms[i].state ||
            oldVms[i].autostart !== newVms[i].autostart
        )
            return true;
    }
    return false;
}

/**
 * Return available actions for a given VM state.
 */
export function getActionsForState(state) {
    const s = (state || "").toLowerCase();
    if (s === "running") {
        return [
            { label: "Shutdown", action: "shutdown" },
            { label: "Reboot", action: "reboot" },
            { label: "Force Off", action: "destroy" },
            { label: "Pause", action: "suspend" },
        ];
    } else if (s === "shut off" || s === "stopped") {
        return [{ label: "Start", action: "start" }];
    } else if (s === "paused" || s === "pmsuspended") {
        return [
            { label: "Resume", action: "resume" },
            { label: "Force Off", action: "destroy" },
        ];
    }
    return [];
}

/**
 * Return the primary quick action shown on the VM pill.
 */
export function getQuickActionForState(state) {
    const s = (state || "").toLowerCase();
    if (s === "running") {
        return { label: "Shutdown", action: "shutdown" };
    } else if (s === "shut off" || s === "stopped") {
        return { label: "Start", action: "start" };
    } else if (s === "paused" || s === "pmsuspended") {
        return { label: "Resume", action: "resume" };
    }
    return null;
}
