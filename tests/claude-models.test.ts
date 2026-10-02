import { describe, expect, it } from "bun:test";
import { buildAgentCommand, buildInlineCommand, type StageSpec } from "../src/herdr/launcher.js";

describe("Claude model resolution", () => {
  it("maps fable-5 and fable-5.1 to claude-fable-5-1", () => {
    expect(buildAgentCommand("claude", { role: "implementer", model: "fable-5", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-fable-5-1", "--effort", undefined, "--dangerously-skip-permissions"]);
    expect(buildAgentCommand("claude", { role: "implementer", model: "fable-5.1", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-fable-5-1", "--effort", undefined, "--dangerously-skip-permissions"]);
  });
  it("maps sonnet-5 variants to claude-sonnet-5-5", () => {
    expect(buildAgentCommand("claude", { role: "implementer", model: "sonnet-5", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-sonnet-5-5", "--effort", undefined, "--dangerously-skip-permissions"]);
    expect(buildAgentCommand("claude", { role: "implementer", model: "claude-sonnet-5", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-sonnet-5-5", "--effort", undefined, "--dangerously-skip-permissions"]);
    expect(buildAgentCommand("claude", { role: "implementer", model: "sonnet-5.5", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-sonnet-5-5", "--effort", undefined, "--dangerously-skip-permissions"]);
  });
  it("maps opus-5 variants to claude-opus-5-5", () => {
    expect(buildAgentCommand("claude", { role: "implementer", model: "opus-5", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-opus-5-5", "--effort", undefined, "--dangerously-skip-permissions"]);
    expect(buildAgentCommand("claude", { role: "implementer", model: "opus-5.5", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-opus-5-5", "--effort", undefined, "--dangerously-skip-permissions"]);
  });
  it("maps haiku-4.5 to claude-haiku-4-5-20251001", () => {
    expect(buildAgentCommand("claude", { role: "implementer", model: "haiku-4.5", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-haiku-4-5-20251001", "--effort", undefined, "--dangerously-skip-permissions"]);
  });
  it("passes through valid target ids and bare aliases", () => {
    expect(buildAgentCommand("claude", { role: "implementer", model: "claude-opus-5-5", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-opus-5-5", "--effort", undefined, "--dangerously-skip-permissions"]);
    expect(buildAgentCommand("claude", { role: "implementer", model: "sonnet", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "sonnet", "--effort", undefined, "--dangerously-skip-permissions"]);
    expect(buildAgentCommand("claude", { role: "implementer", model: "opus", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "opus", "--effort", undefined, "--dangerously-skip-permissions"]);
    expect(buildAgentCommand("claude", { role: "implementer", model: "haiku", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "haiku", "--effort", undefined, "--dangerously-skip-permissions"]);
    expect(buildAgentCommand("claude", { role: "implementer", model: "fable", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "fable", "--effort", undefined, "--dangerously-skip-permissions"]);
  });
  it("applies in reviewer command of the claude client", () => {
    expect(buildAgentCommand("claude", { role: "reviewer", model: "fable-5.1", effort: undefined, extraFlags: [], description: "" })).toEqual(["claude", "--model", "claude-fable-5-1", "--effort", undefined, "--tools", "Read,Glob,Grep"]);
  });
});
