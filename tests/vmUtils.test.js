import { describe, it } from "node:test";
import assert from "node:assert";
import {
    parseVirshOutput,
    parseDomInfo,
    parseDomIfAddr,
    vmsChanged,
    getActionsForState
} from "../src/vmUtils.js";

describe("VM Utils - parseVirshOutput Edge Cases", () => {
    it("handles very long VM names that might shift columns", () => {
        const output = `
 Id   Name                                  State
----------------------------------------------------
 1    my-very-very-long-suse-linux-server   running
 -    short-name                            shut off
        `;
        const vms = parseVirshOutput(output);
        assert.strictEqual(vms[0].name, "my-very-very-long-suse-linux-server");
        assert.strictEqual(vms[0].state, "running");
    });

    it("handles multi-word states (e.g. in shutdown)", () => {
        const output = `
 Id   Name      State
----------------------------
 5    ubuntu    in shutdown
        `;
        const vms = parseVirshOutput(output);
        assert.strictEqual(vms[0].state, "in shutdown");
    });

    it("handles corrupt lines safely", () => {
        const output = `
 Id   Name      State
----------------------------
 CORRUPT_LINE_WITHOUT_COLUMNS
 1    ubuntu    running
        `;
        const vms = parseVirshOutput(output);
        assert.strictEqual(vms.length, 1);
        assert.strictEqual(vms[0].name, "ubuntu");
    });
});

describe("VM Utils - parseDomInfo Edge Cases", () => {
    it("handles large memory units (MiB, GiB, TiB)", () => {
        const mibOutput = "Max memory: 4096 MiB\nUsed memory: 2048 MiB";
        const gibOutput = "Max memory: 4 GiB\nUsed memory: 2 GiB";
        const tibOutput = "Max memory: 1 TiB\nUsed memory: 0.5 TiB";

        assert.strictEqual(parseDomInfo(mibOutput).memoryGb, "2.0");
        assert.strictEqual(parseDomInfo(gibOutput).memoryGb, "2.0");
        assert.strictEqual(parseDomInfo(tibOutput).memoryGb, "512.0");
    });

    it("handles missing memory fields gracefully", () => {
        const output = "Id: 1\nName: ubuntu";
        const info = parseDomInfo(output);
        assert.strictEqual(info.memoryGb, undefined);
    });
});

describe("VM Utils - parseDomIfAddr Edge Cases", () => {
    it("returns null when no IPv4 is present", () => {
        const output = `
 Name       MAC address          Protocol     Address
-------------------------------------------------------------------------------
 lo         00:00:00:00:00:00    ipv6         ::1/128
        `;
        assert.strictEqual(parseDomIfAddr(output), null);
    });

    it("handles empty or error output", () => {
        assert.strictEqual(parseDomIfAddr(""), null);
        assert.strictEqual(parseDomIfAddr("error: could not get interface addresses"), null);
    });
});

describe("VM Utils - getActionsForState Edge Cases", () => {
    it("is case-insensitive for states", () => {
        const actions = getActionsForState("RUNNING");
        assert.ok(actions.length > 0);
        assert.strictEqual(actions[0].action, "shutdown");
    });

    it("handles unknown or weird states", () => {
        assert.deepStrictEqual(getActionsForState("ALIEN_STATE"), []);
        assert.deepStrictEqual(getActionsForState(null), []);
    });
});
