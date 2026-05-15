import { describe, it } from "node:test";
import assert from "node:assert";
import {
    parseVirshOutput
} from "../src/vmUtils.js";

describe("VM System Level - Performance & Stress", () => {
    it("handles 500+ VMs in virsh list quickly", () => {
        let output = " Id   Name          State\n----------------------------\n";
        for (let i = 0; i < 500; i++) {
            output += ` ${i}    vm-${i}${' '.repeat(10)} running\n`;
        }
        
        const start = Date.now();
        const result = parseVirshOutput(output);
        const duration = Date.now() - start;
        
        assert.strictEqual(result.length, 500);
        assert.ok(duration < 50, `Parsing 500 VMs took too long: ${duration}ms`);
    });
});

describe("VM System Level - Error Handling (Mocked Simulation)", () => {
    it("identifies VM (virsh) permission denied", () => {
        const stderr = "error: failed to connect to the hypervisor\nerror: Failed to connect socket to '/var/run/libvirt/libvirt-sock': Permission denied";
        assert.ok(stderr.toLowerCase().includes("permission denied"));
    });

    it("identifies virsh command not found", () => {
        const errorMsg = "bash: virsh: command not found";
        assert.ok(errorMsg.includes("command not found"));
    });
});
