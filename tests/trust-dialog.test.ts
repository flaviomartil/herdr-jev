import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requiresTrustConfirmation } from "../src/herdr/client.js";

describe("Trust Dialog Detection", () => {
  it("detects 27-column wrapped agy trust dialog from fixture", () => {
    const fixturePath = join(process.cwd(), "tests/fixtures/agy-trust-dialog-27cols.txt");
    const stdout = readFileSync(fixturePath, "utf-8");
    const result = { ok: true, stdout, stderr: "" };
    expect(requiresTrustConfirmation(result)).toBe(true);
  });

  it("detects 80-column unwrapped agy trust dialog", () => {
    const stdout = "Accessing workspace:\\n/tmp/jev-live-Mnv4-wt-t3\\n\\nDo you trust the contents of this project?\\n\\nAntigravity CLI requires permission to read, edit, and execute files here.\\n\\n> Yes, I trust this folder\\n  No, exit\\n\\n  ↑/↓ Navigate\\n  enter Confirm";
    const result = { ok: true, stdout, stderr: "" };
    expect(requiresTrustConfirmation(result)).toBe(true);
  });
});
