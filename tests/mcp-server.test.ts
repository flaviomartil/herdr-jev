import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("Herdr-Jev MCP Server", () => {
  const cliPath = join(import.meta.dir, "../src/cli.ts");

  it("responds to initialize and lists tools via stdio json-rpc", () => {
    const inputPayload = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ].join("\n") + "\n";

    const res = spawnSync("bun", [cliPath, "mcp"], {
      input: inputPayload,
      encoding: "utf8",
    });

    expect(res.status).toBe(0);
    const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);

    // Check initialize response
    expect(lines[0].id).toBe(1);
    expect(lines[0].result.serverInfo.name).toBe("herdr-jev-mcp");

    // Check tools list response
    expect(lines[1].id).toBe(2);
    const tools = lines[1].result.tools;
    expect(Array.isArray(tools)).toBe(true);
    const toolNames = tools.map((t: any) => t.name);
    expect(toolNames).toContain("herdr_clink");
    expect(toolNames).toContain("herdr_spawn_subagent");
    expect(toolNames).toContain("herdr_consensus");
    expect(toolNames).toContain("herdr_triage");
    expect(toolNames).toContain("herdr_decide");
    expect(toolNames).toContain("herdr_gate");
    expect(toolNames).toContain("herdr_execution_guard");
    expect(toolNames).toContain("herdr_verify_contract");
    expect(toolNames).toContain("herdr_fit_check");
    expect(toolNames.length).toBe(9);
  });
});
