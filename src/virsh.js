import Gio from "gi://Gio";
import GLib from "gi://GLib";
import {
    parseVirshOutput,
    parseDomInfo,
    parseDomIfAddr,
    parseDomBlkInfo,
    parseDomStats,
} from "./vmUtils.js";

let _eventProc = null;
let _eventCancellable = null;

/**
 * Run a virsh command and return stdout.
 */
function runVirsh(args) {
    return new Promise((resolve, reject) => {
        try {
            const proc = Gio.Subprocess.new(
                ["virsh", "-c", "qemu:///system", ...args],
                Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            );

            proc.communicate_utf8_async(null, null, (_proc, res) => {
                try {
                    const [, stdout, stderr] =
                        _proc.communicate_utf8_finish(res);

                    if (!_proc.get_successful()) {
                        const cmd = `virsh ${args.join(" ")}`;
                        reject(
                            new Error(
                                `${cmd} failed: ${stderr.trim() || "unknown error"}`,
                            ),
                        );
                        return;
                    }

                    resolve(stdout);
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Run `virsh list --all` and return an array of VM objects.
 * Each object: { name: string, state: string, autostart: boolean }
 */
export async function getVirtualMachines() {
    const [allOutput, autostartOutput] = await Promise.all([
        runVirsh(["list", "--all"]),
        runVirsh(["list", "--all", "--autostart"]),
    ]);

    const allVms = parseVirshOutput(allOutput);
    const autostartNames = new Set(
        parseVirshOutput(autostartOutput).map((vm) => vm.name),
    );

    for (const vm of allVms) {
        vm.autostart = autostartNames.has(vm.name);
    }

    return allVms;
}

/**
 * Get details for a specific VM (RAM, CPU, IP).
 */
export async function getVmDetails(vmName, isRunning) {
    const promises = [
        runVirsh(["dominfo", vmName]),
        runVirsh(["domblkinfo", vmName, "--all"]).catch(() => ""),
    ];
    if (isRunning) {
        // domifaddr can fail if the VM is booting or has no network agent
        promises.push(runVirsh(["domifaddr", vmName]).catch(() => ""));
    }

    const results = await Promise.all(promises);
    const infoOutput = results[0];
    const blkOutput = results[1];
    const addrOutput = results[2] ?? "";

    const info = parseDomInfo(infoOutput);

    const disk = parseDomBlkInfo(blkOutput);
    if (disk) info.disk = disk;

    if (isRunning && addrOutput) {
        info.ip = parseDomIfAddr(addrOutput);
    }

    return info;
}

/**
 * Run a virsh action on a VM (e.g. start, shutdown, destroy, suspend, resume, reboot).
 */
export function runVirshAction(action, vmName) {
    return runVirsh([action, vmName]);
}

/**
 * Fetch live CPU time and balloon memory stats for a running VM.
 */
export async function getVmLiveStats(vmName) {
    const output = await runVirsh(["domstats", "--cpu-total", "--balloon", vmName]);
    return parseDomStats(output);
}


/**
 * Read file contents asynchronously.
 */
function _readFileAsync(path) {
    return new Promise((resolve) => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (obj, res) => {
            try {
                const [ok, contents] = obj.load_contents_finish(res);
                resolve(ok ? new TextDecoder().decode(contents) : null);
            } catch (_e) {
                resolve(null);
            }
        });
    });
}

/**
 * Get the actual Unix start time (ms) of a running VM by reading
 * the QEMU process start time from /proc/<pid>/stat.
 * Returns null if anything fails (VM not running, no pid file, etc.).
 */
export async function getVmStartTimeMs(vmName) {
    try {
        // libvirt writes the QEMU process PID here when the VM is running
        const pidStr = await _readFileAsync(`/run/libvirt/qemu/${vmName}.pid`);
        if (!pidStr) return null;
        const pid = parseInt(pidStr.trim());
        if (isNaN(pid) || pid <= 0) return null;

        // /proc/<pid>/stat: field 22 (starttime) = clock ticks since boot
        const stat = await _readFileAsync(`/proc/${pid}/stat`);
        if (!stat) return null;

        // comm (field 2) is in parens and may contain spaces; parse after last ')'
        const afterComm = stat.substring(stat.lastIndexOf(")") + 2);
        const starttime = parseInt(afterComm.split(" ")[19]); // field 22 → index 19
        if (isNaN(starttime)) return null;

        // /proc/stat: btime = system boot time (seconds since epoch)
        const procStat = await _readFileAsync("/proc/stat");
        if (!procStat) return null;
        const btimeLine = procStat.split("\n").find((l) => l.startsWith("btime "));
        if (!btimeLine) return null;
        const btime = parseInt(btimeLine.split(" ")[1]);
        if (isNaN(btime)) return null;

        // CLK_TCK is 100 on all modern Linux x86_64 systems
        return (btime + starttime / 100) * 1000;
    } catch (_e) {
        return null;
    }
}

/**
 * Toggle autostart for a VM.
 */
export function toggleAutoStart(vmName, enable) {
    const args = enable
        ? ["autostart", vmName]
        : ["autostart", "--disable", vmName];
    return runVirsh(args);
}

/**
 * Start a long-running `virsh event --all --loop` subprocess.
 * Calls onEvent(line) for each event line received.
 * Calls onDied() if the subprocess exits unexpectedly.
 */
export function startEventListener(onEvent, onDied) {
    stopEventListener();

    _eventCancellable = new Gio.Cancellable();

    _eventProc = Gio.Subprocess.new(
        ["virsh", "-c", "qemu:///system", "event", "--all", "--loop"],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    );

    const stdout = new Gio.DataInputStream({
        base_stream: _eventProc.get_stdout_pipe(),
    });

    const readLine = () => {
        stdout.read_line_async(
            GLib.PRIORITY_DEFAULT,
            _eventCancellable,
            (stream, res) => {
                try {
                    const [line] = stream.read_line_finish_utf8(res);
                    if (line !== null) {
                        onEvent(line);
                        readLine();
                    } else {
                        // stream ended — subprocess died
                        if (onDied) onDied();
                    }
                } catch (_e) {
                    // cancelled via stopEventListener — ignore
                }
            },
        );
    };

    readLine();
}

/**
 * Stop the event listener subprocess.
 */
export function stopEventListener() {
    if (_eventCancellable) {
        _eventCancellable.cancel();
        _eventCancellable = null;
    }
    if (_eventProc) {
        try {
            _eventProc.force_exit();
        } catch (_e) {
            // already dead
        }
        _eventProc = null;
    }
}

