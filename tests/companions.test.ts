import { expect, test } from "bun:test";
import { studio, studioEventPane } from "../src/herdr/studio.js";
import { codexEffortScreen, changeEffort } from "../src/herdr/effort.js";
import { openSession, sessionRow } from "../src/herdr/sessions.js";
import type { RunCommand } from "../src/herdr/client.js";

const success = (result: unknown) => ({ ok: true, code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const unlocked = async () => async () => {};

test("studio preserves source, reuses panes, scopes events and keeps completion reported", async () => {
  const source = { pane_id: "w1:p1", tab_id: "w1:t1", agent: "codex", agent_status: "working", cwd: "/tmp/repo",
    agent_session: { kind: "id", value: "native-1" }, tokens: {} as Record<string,string> };
  const panes: any[] = [source];
  const calls: string[][] = [];
  let unresolved = false;
  const run: RunCommand = async argv => {
    calls.push([...argv]);
    if (argv.includes("snapshot")) return success({ snapshot: { agents: [source], panes } });
    if (argv.includes("report-metadata")) {
      const token = argv.at(-1)!; const equal = token.indexOf("="); source.tokens[token.slice(0,equal)] = token.slice(equal+1);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    }
    if (argv.includes("open")) {
      if (unresolved) return { ok: false, code: 1, stdout: "", stderr: "socket timeout" };
      const pane = { pane_id: `w1:p${panes.length+1}`, tab_id: source.tab_id }; panes.push(pane);
      return success({ plugin_pane: { pane } });
    }
    return { ok: true, code: 0, stdout: " M file.ts", stderr: "" };
  };
  expect(await studio({ pane: source.pane_id, event: true },run,unlocked)).toEqual({ status: "ignored" });
  await studio({ pane: source.pane_id },run,unlocked);await studio({ pane: source.pane_id },run,unlocked);
  expect(calls.filter(call=>call.includes("open"))).toHaveLength(2);
  source.agent_status = "done";
  expect(await studio({ pane: source.pane_id, event: true },run,unlocked)).toMatchObject({ status: "review-open", completion: "reported" });
  await studio({ pane: source.pane_id, event: true },run,unlocked);
  expect(calls.filter(call=>call.includes("open"))).toHaveLength(3);
  source.agent_session.value = "new-native";
  expect(await studio({ pane: source.pane_id, event: true },run,unlocked)).toEqual({ status: "ignored" });
  await studio({ pane: source.pane_id, disable: true },run,unlocked);
  expect(source.tokens.jev_studio_enabled).toBe("false");
  source.tokens.jev_studio_shell = "missing"; unresolved = true;
  await expect(studio({ pane: source.pane_id },run,unlocked)).rejects.toThrow("socket timeout");
  const count = calls.filter(call=>call.includes("open")).length;
  await expect(studio({ pane: source.pane_id },run,unlocked)).rejects.toThrow("dispatch unresolved");
  expect(calls.filter(call=>call.includes("open"))).toHaveLength(count);
  expect(calls.some(call=>call.includes("start") || call.includes("run") || call.includes("close"))).toBe(false);
  expect(studioEventPane(JSON.stringify({ data: { agent_status: "done", pane_id: "w1:p1" } }))).toBe("w1:p1");
  expect(studioEventPane(JSON.stringify({ data: { agent_status: "idle", pane_id: "w1:p1" } }))).toBeUndefined();
});

test("native Codex effort is verified without retry, launch or composer submission", async () => {
  const before = "›\n\ngpt-6.1-sol medium · /tmp/repo";
  expect(codexEffortScreen(before)).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
  for (const unsafe of ["› draft\ngpt-6.1-sol medium", "gpt-6.1-sol medium\n›\nquota only",
    "›\nwrapped draft\ngpt-6.1-sol medium", "›\ngpt-6.1-sol medium Plan mode"]) {
    expect(()=>codexEffortScreen(unsafe)).toThrow();
  }
  const pane = process.env.HERDR_PANE_ID || "w1:p1";
  const agent = { pane_id: pane, terminal_id: "term-1", agent: "codex", agent_status: "idle" };
  let effort = "medium";
  const calls: string[][] = [];
  const run: RunCommand = async argv => {
    calls.push([...argv]);
    if (argv.includes("get")) return success({ agent });
    if (argv.includes("send-keys")) { effort = "high"; return success({}); }
    return { ok: true, code: 0, stdout: `›\ngpt-6.1-sol ${effort}`, stderr: "" };
  };
  expect(await changeEffort(pane,"high",run,unlocked)).toMatchObject({ status: "applied", effective: "next-turn" });
  expect(calls.filter(call=>call.includes("send-keys"))).toHaveLength(1);
  expect(calls.find(call=>call.includes("send-keys"))!.at(-1)).toBe("alt+.");
  expect(calls.some(call=>call.includes("enter") || call.includes("start"))).toBe(false);
  agent.agent_status = "blocked";
  await expect(changeEffort(pane,"low",run,unlocked)).rejects.toThrow("idle Codex");
});

test("session selection uses exact native identity and refuses duplicate live sessions", async () => {
  const session = { key: "codex:abcdef", native_id: "native", client: "codex", cwd: "/tmp/repo", title: "title\n\u001b[31m" };
  expect(sessionRow(session).split("\t")).toHaveLength(4);
  expect(sessionRow(session)).not.toContain("\u001b");
  expect(()=>sessionRow({ ...session,key:"$(touch unsafe)" })).toThrow();
  let agents: any[] = [{ pane_id: "w1:p1", agent: "codex", agent_session: { kind: "id", value: "native" } }];
  const calls: string[][] = [];
  const run: RunCommand = async argv => { calls.push([...argv]);return success(argv.includes("snapshot") ? { snapshot: { agents } } : {}); };
  expect(await openSession(session,run)).toMatchObject({ status: "focused" });
  expect(calls.at(-1)).toContain("focus");
  agents = [...agents,...agents];await expect(openSession(session,run)).rejects.toThrow("multiple panes");
  agents = [{ agent: "codex", cwd: session.cwd, pane_id: "w1:p1" }];
  await expect(openSession(session,run)).rejects.toThrow("no native session identity");
  agents = [];expect(await openSession(session,run)).toMatchObject({ status: "dispatched" });
  expect(calls.at(-1)).toContain("session-resume");
  expect(calls.at(-1)).toContain("HERDR_JEV_RESUME_SESSION=codex:abcdef");
});
