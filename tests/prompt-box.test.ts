import { describe, expect, test } from "bun:test";
import { inspectPromptBoxAnsi } from "../src/herdr/prompt-box.js";

describe("inspectPromptBoxAnsi", () => {
  test("returns unseen when no prompt box marker is present in bottom lines", () => {
    expect(inspectPromptBoxAnsi("")).toEqual({ state: "unseen", shouldHold: false });
    expect(inspectPromptBoxAnsi("Working on task...\nAll checks passed.")).toEqual({ state: "unseen", shouldHold: false });

    const buried = [
      "❯ old prompt from history",
      ...Array.from({ length: 18 }, (_, i) => `output line ${i}`),
    ].join("\n");
    expect(inspectPromptBoxAnsi(buried)).toEqual({ state: "unseen", shouldHold: false });
  });

  test("returns empty for blank Claude and Codex prompt lines", () => {
    expect(inspectPromptBoxAnsi("────────\n❯ \n────────")).toEqual({
      state: "empty",
      shouldHold: false,
      marker: "❯",
    });
    expect(inspectPromptBoxAnsi("│ ›   │\n? for shortcuts")).toEqual({
      state: "empty",
      shouldHold: false,
      marker: "›",
    });
  });

  test("treats SGR dim/faint/gray placeholder suggestions as non-blocking", () => {
    const dim2m = "\x1b[0m❯ \x1b[2mTry \"fix lint errors\"\x1b[0m\n? for shortcuts";
    expect(inspectPromptBoxAnsi(dim2m)).toEqual({
      state: "placeholder_only",
      shouldHold: false,
      marker: "❯",
    });

    const gray90m = "\x1b[0m› \x1b[90mAsk Codex to do anything\x1b[39m\n100% context left";
    expect(inspectPromptBoxAnsi(gray90m, { clientKind: "codex" })).toEqual({
      state: "placeholder_only",
      shouldHold: false,
      marker: "›",
    });

    const gray256 = "\x1b[0m❯ \x1b[38;5;244mPress enter to continue\x1b[0m";
    expect(inspectPromptBoxAnsi(gray256, { clientKind: "claude" })).toEqual({
      state: "placeholder_only",
      shouldHold: false,
      marker: "❯",
    });
  });

  test("blocks on normal-intensity human draft and strips trailing dim ghost suggestion", () => {
    const plainDraft = "\x1b[0m❯ refactor the auth guard\n? for shortcuts";
    expect(inspectPromptBoxAnsi(plainDraft)).toEqual({
      state: "human_draft",
      shouldHold: true,
      draftPreview: "refactor the auth guard",
      marker: "❯",
    });

    const withGhost = "\x1b[0m› fix \x1b[2mthe remaining type errors\x1b[0m";
    expect(inspectPromptBoxAnsi(withGhost)).toEqual({
      state: "human_draft",
      shouldHold: true,
      draftPreview: "fix",
      marker: "›",
    });
  });

  test("blocks on shell mode (!) and multi-line paste placeholders even if dim", () => {
    expect(inspectPromptBoxAnsi("❯ !git status")).toEqual({
      state: "human_draft",
      shouldHold: true,
      draftPreview: "!git status",
      marker: "❯",
    });

    expect(inspectPromptBoxAnsi("\x1b[0m❯ \x1b[2m[Pasted text #1 +14 lines]\x1b[0m")).toEqual({
      state: "human_draft",
      shouldHold: true,
      draftPreview: "[Pasted text #1 +14 lines]",
      marker: "❯",
    });
  });

  test("inspects the bottom-most prompt line rather than earlier turn prompts", () => {
    const screen = [
      "\x1b[0m❯ earlier completed prompt",
      "● Done.",
      "────────────────────────",
      "\x1b[0m❯ \x1b[2mAsk Claude anything\x1b[0m",
      "────────────────────────",
    ].join("\n");
    expect(inspectPromptBoxAnsi(screen)).toEqual({
      state: "placeholder_only",
      shouldHold: false,
      marker: "❯",
    });
  });

  test("consumes 48/58 background/underline colors, skips CSI private params, supports colon SGR, and slices codepoint-safely", () => {
    expect(inspectPromptBoxAnsi("\x1b[48;2;30;30;40m❯ draft on dark bg\x1b[0m")).toEqual({
      state: "human_draft",
      shouldHold: true,
      draftPreview: "draft on dark bg",
      marker: "❯",
    });

    expect(inspectPromptBoxAnsi("\x1b[48;5;90m❯ draft on 256 bg\x1b[0m")).toEqual({
      state: "human_draft",
      shouldHold: true,
      draftPreview: "draft on 256 bg",
      marker: "❯",
    });

    expect(inspectPromptBoxAnsi("\x1b[>4;2m❯ draft after modifyOtherKeys\x1b[0m")).toEqual({
      state: "human_draft",
      shouldHold: true,
      draftPreview: "draft after modifyOtherKeys",
      marker: "❯",
    });

    expect(inspectPromptBoxAnsi("\x1b[0m❯ \x1b[38:2::120:120:120mAsk Claude anything\x1b[0m")).toEqual({
      state: "placeholder_only",
      shouldHold: false,
      marker: "❯",
    });

    expect(inspectPromptBoxAnsi("\x1b[0m› \x1b[38:5:244mAsk Codex anything\x1b[0m")).toEqual({
      state: "placeholder_only",
      shouldHold: false,
      marker: "›",
    });

    const longEmojiDraft = `❯ ${"a".repeat(79)}🚀tail`;
    const emojiRes = inspectPromptBoxAnsi(longEmojiDraft);
    expect(emojiRes.state).toBe("human_draft");
    expect(emojiRes.shouldHold).toBe(true);
    expect(emojiRes.draftPreview).toBe(`${"a".repeat(79)}🚀`);
  });
});
