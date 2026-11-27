import { describe, expect, test } from "bun:test";
import { classifyHerdrError } from "../src/herdr/errors.js";
import { classifyHerdrCommandFailure } from "../src/herdr/client.js";

describe("classifyHerdrError 4-way taxonomy", () => {
  test("classifies temporary_pre_invocation codes accurately", () => {
    for (const code of ["agent_not_found", "pane_not_found", "agent_busy", "agent_pane_busy", "agent_blocked"]) {
      const res = classifyHerdrError({
        ok: false,
        code: 1,
        stdout: JSON.stringify({ error: { code, message: `failed: ${code}` } }),
        stderr: "",
      });
      expect(res.category).toBe("temporary_pre_invocation");
      expect(res.code).toBe(code);
      expect(res.retryable).toBe(true);
      expect(res.mayHaveLanded).toBe(false);
      expect(res.legacyAck).toBe(code === "agent_blocked" ? "unknown" : "rejected");
      expect(res.message).toBe(`failed: ${code}`);
    }
  });

  test("classifies temporary_no_event codes accurately", () => {
    for (const code of ["agent_not_ready", "conflict", "server_busy"]) {
      const res = classifyHerdrError({
        ok: false,
        code: 1,
        stdout: "",
        stderr: JSON.stringify({ code, message: `temp: ${code}` }),
      });
      expect(res.category).toBe("temporary_no_event");
      expect(res.code).toBe(code);
      expect(res.retryable).toBe(true);
      expect(res.mayHaveLanded).toBe(false);
      expect(res.legacyAck).toBe("unknown");
      expect(res.message).toBe(`temp: ${code}`);
    }
  });

  test("classifies definitive_non_retryable codes accurately", () => {
    for (const code of ["invalid_request", "invalid_args", "invalid_input", "unsupported", "unknown_command"]) {
      const res = classifyHerdrError({
        ok: false,
        code: 1,
        stdout: JSON.stringify({ error: { code } }),
        stderr: "",
      });
      expect(res.category).toBe("definitive_non_retryable");
      expect(res.code).toBe(code);
      expect(res.retryable).toBe(false);
      expect(res.mayHaveLanded).toBe(false);
      expect(res.legacyAck).toBe("rejected");
    }
  });

  test("classifies ambiguous errors including agent_prompt_stalled, timeouts, EOF, and non-JSON", () => {
    const stalled = classifyHerdrError({
      ok: false,
      code: 1,
      stdout: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "stalled in box" } }),
      stderr: "",
    });
    expect(stalled).toEqual({
      category: "ambiguous",
      code: "agent_prompt_stalled",
      retryable: false,
      mayHaveLanded: true,
      legacyAck: "unknown",
      message: "stalled in box",
    });

    for (const stderr of [
      "command timed out; acknowledgement unknown",
      "unexpected EOF from daemon",
      "transport socket closed",
      "something completely opaque",
    ]) {
      const res = classifyHerdrError({ ok: false, code: 1, stdout: "", stderr });
      expect(res.category).toBe("ambiguous");
      expect(res.code).toBeNull();
      expect(res.retryable).toBe(false);
      expect(res.mayHaveLanded).toBe(true);
      expect(res.legacyAck).toBe("unknown");
    }
  });

  test("preserves classifyHerdrCommandFailure legacy contract across structured and plain errors", () => {
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: JSON.stringify({ error: { code: "agent_not_found" } }), stderr: "" })).toBe("rejected");
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: JSON.stringify({ error: { code: "pane_not_found" } }), stderr: "" })).toBe("rejected");
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: JSON.stringify({ error: { code: "invalid_args" } }), stderr: "" })).toBe("rejected");
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: JSON.stringify({ error: { code: "agent_not_ready" } }), stderr: "" })).toBe("unknown");
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: JSON.stringify({ error: { code: "agent_blocked" } }), stderr: "" })).toBe("unknown");
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: JSON.stringify({ error: { code: "agent_prompt_stalled" } }), stderr: "" })).toBe("unknown");
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: "", stderr: "ECONNREFUSED" })).toBe("unknown");
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: "", stderr: "spawn herdr ENOENT" })).toBe("unknown");
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: "", stderr: "layout refused" })).toBe("rejected");
    expect(classifyHerdrCommandFailure({ ok: false, code: 1, stdout: "", stderr: "unsupported agent kind" })).toBe("rejected");

    const stringEnvelope = classifyHerdrError({
      ok: false,
      code: 1,
      stdout: JSON.stringify({ error: "agent_not_ready", message: "warming" }),
      stderr: "",
    });
    expect(stringEnvelope.category).toBe("temporary_no_event");
    expect(stringEnvelope.code).toBe("agent_not_ready");

    expect(classifyHerdrError({ ok: false, code: 1, stdout: "", stderr: "resource conflict" }).category).toBe("temporary_no_event");
    expect(classifyHerdrError({ ok: false, code: 1, stdout: "", stderr: "unsupported operation" }).category).toBe("definitive_non_retryable");
  });
});
