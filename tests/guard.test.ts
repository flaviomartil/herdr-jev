import { expect, test, beforeAll } from "bun:test";
import { createProcessCommandAdapter, createHerdrClient } from "../src/herdr/client.js";
import { converseWithPeer } from "../src/herdr/peer.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync } from "node:fs";

beforeAll(() => {
  process.env.HERDR_JEV_TEST_GUARD = '1';
});

test("with the guard on, converseWithPeer against the default client never spawns and reports failure", async () => {
  const adapter = createProcessCommandAdapter();
  process.env.HERDR_BIN_PATH = "herdr";
  const client = createHerdrClient(adapter);
  client.getAgent = async () => ({ ok: true, stdout: JSON.stringify({ result: { agent: { pane_id: "pane", status: "idle" } } }), stderr: "", code: 0 });
  client.readAgent = async () => ({ ok: true, stdout: 'hello', stderr: "", code: 0 });
  client.waitFor = async () => ({ ok: true, stdout: '{"pane":"pane","state":"idle"}', stderr: "", code: 0 });
  
  let errorMsg = "";
  try {
    await converseWithPeer({ target: "test-target", text: "hello" }, client);
  } catch (e: any) {
    errorMsg = e.message;
  }
  expect(errorMsg).toContain("blocked_by_test_guard");
});

test("a fake herdr script under the OS temp dir still works", async () => {
  const fakeBin = join(tmpdir(), "fake-herdr");
  await Bun.write(fakeBin, "#!/bin/sh\necho 'hello from fake'");
  chmodSync(fakeBin, 0o755);
  
  process.env.HERDR_BIN_PATH = fakeBin;
  const adapter = createProcessCommandAdapter();
  const res = await adapter([fakeBin, "agent", "start"]);
  expect(res.ok).toBe(true);
  expect(res.stdout).toContain("hello from fake");
});

test("read-only commands still work", async () => {
  process.env.HERDR_BIN_PATH = "herdr";
  const adapter = createProcessCommandAdapter();
  const res = await adapter(["herdr", "agent", "list"]);
  expect(res.stderr).not.toContain("blocked_by_test_guard");
});
