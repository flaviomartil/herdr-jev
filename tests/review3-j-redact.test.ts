import { expect, test } from "bun:test";
import { lastMeaningfulLine, redactSecrets } from "../src/herdr/pane-text.ts";

const SECRET = "Kd93Ls0QwErTyUiOpAsDfGhJkLzXcVbN12";

test("round 3 finding 4: a token run cut by the redaction bound never leaves a prefix", () => {
  const text = `${"w ".repeat(3900)}${"a,".repeat(60)}${SECRET}${"b,".repeat(300)}`;
  const out = redactSecrets(text);
  expect(out).not.toContain(SECRET.slice(0, 12));
  expect(out.length).toBeLessThanOrEqual(8192);
});

test("round 3 finding 4: input beyond the bound without any whitespace is fully redacted", () => {
  const text = `${"a,".repeat(5000)}${SECRET}${"b,".repeat(5000)}`;
  const out = redactSecrets(text);
  expect(out).toBe("[REDACTED]");
});

test("round 3 finding 4: a long line with a secret in its cut run stays hidden through the line extractor", () => {
  const long = `${"w ".repeat(3900)}${"a,".repeat(60)}${SECRET}${"b,".repeat(300)}`;
  const out = lastMeaningfulLine(`${long}\nnext`);
  expect(out).not.toContain(SECRET.slice(0, 12));
});

test("round 3 finding 5: truncation of long input is explicit and keeps the head", () => {
  const out = redactSecrets(`${"word ".repeat(2000)}tail`);
  expect(out.length).toBeLessThanOrEqual(8192);
  expect(out.endsWith(" [TRUNCATED]")).toBe(true);
  expect(out.startsWith("word word")).toBe(true);
  expect(out).not.toContain("tail");
});

test("round 3 finding 5: input at the classifier worst case is never truncated", () => {
  const worstCase = "word ".repeat(1405).slice(0, 6000 + 1024);
  expect(worstCase.length).toBe(7024);
  const out = redactSecrets(worstCase);
  expect(out).toBe(worstCase);
  expect(out).not.toContain("[TRUNCATED]");
});

test("round 3 finding 5: input exactly at the bound is returned whole", () => {
  const exact = "ab ".repeat(2730).slice(0, 8192);
  expect(exact.length).toBe(8190);
  const padded = `${exact}cd`;
  expect(padded.length).toBe(8192);
  expect(redactSecrets(padded)).toBe(padded);
});
