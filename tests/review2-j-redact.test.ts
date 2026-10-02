import { expect, test } from "bun:test";
import { lastMeaningfulLine, redactSecrets } from "../src/herdr/pane-text.ts";
import { MAX_CLASSIFY_PANE_TEXT_CHARS, classifyPaneText } from "../src/triage/pane-classifier.ts";

const VALUE = "p4ss" + "w0rd" + "v4lue" + "9";
const SHORT = "abcd" + "1234";

test("round 2 finding 1: a keyword at the end of a line never leaves the wrapped value visible", () => {
  const samples = [
    `run --token\n${SHORT} --verbose`,
    `run --token\n\n${SHORT} --verbose`,
    `run --api-key\n${VALUE}`,
    `export PASSWORD:\n${VALUE}`,
    `export API_KEY=\n${VALUE}`,
    `Authorization: Bearer\n${SHORT}`,
    `curl -H Bearer\n${SHORT} https://example.com`,
    `Authorization: Basic\ndXNlcjpw${"YXNz"}`,
    `│ run --token │\n│ ${SHORT} --verbose │`,
    `${"x".repeat(60)} --secret\n${VALUE}`,
  ];
  for (const sample of samples) {
    const out = lastMeaningfulLine(sample);
    expect(out, sample).not.toContain(SHORT);
    expect(out, sample).not.toContain(VALUE);
    expect(out, sample).not.toContain("dXNlcjpw");
  }
});

test("round 2 finding 1: the key line is dropped when the value line is hidden chrome", () => {
  const out = lastMeaningfulLine(`run --token\n${SHORT} esc to interrupt`);
  expect(out).not.toContain(SHORT);
  expect(out).not.toContain("--token");
});

test("round 2 finding 1: a wrap on the next line is caught with and without a separating space", () => {
  expect(lastMeaningfulLine(`first line\nrun --token\n${SHORT}\nlater`)).toBe("later");
  expect(lastMeaningfulLine(`password:\n${VALUE}\nlater`)).toBe("later");
  expect(lastMeaningfulLine(`token=\n${VALUE}\nlater`)).toBe("later");
  expect(lastMeaningfulLine(`run Bearer\n${SHORT}\nlater`)).toBe("later");
});

test("round 2 finding 1: ordinary adjacent lines are still shown", () => {
  expect(lastMeaningfulLine("compiling the project\nall tests passed")).toBe("all tests passed");
  expect(lastMeaningfulLine("the bearer\nof news arrived")).toBe("of news arrived");
  expect(lastMeaningfulLine("see the token\nreference guide")).toBe("reference guide");
});

test("round 2 finding 9: a line holding its own secret is dropped instead of shown", () => {
  expect(lastMeaningfulLine(`done building\nAPI_KEY=${VALUE}`)).toBe("done building");
  expect(lastMeaningfulLine(`export TOKEN=${VALUE}\nstatus ok`)).not.toContain(VALUE);
  expect(lastMeaningfulLine(`status ok\nexport TOKEN=${VALUE}`)).toBe("status ok");
});

test("round 2 finding 2: a scheme word after a secret key does not shield the token", () => {
  expect(redactSecrets(`X-Auth-Token: Bearer ${SHORT}`)).toBe("X-Auth-Token: [REDACTED]");
  expect(redactSecrets(`token=bearer ${SHORT}`)).toBe("token=[REDACTED]");
  expect(redactSecrets(`run --token Basic ${SHORT}`)).toBe("run --token [REDACTED]");
  expect(redactSecrets(`api_key: Basic ${SHORT}`)).toBe("api_key: [REDACTED]");
  expect(redactSecrets(`Authorization: Bearer ${SHORT}`)).toBe("Authorization: Bearer [REDACTED]");
});

test("round 2 finding 3: an unquoted secret keeps going across semicolons, ampersands and commas", () => {
  const password = "Xk3;f9&Lm,2";
  const out = redactSecrets(`DB_PASSWORD=${password}`);
  expect(out).toBe("DB_PASSWORD=[REDACTED]");
  expect(redactSecrets(`password: ${password}`)).toBe("password: [REDACTED]");
  expect(redactSecrets(`--password ${password} --verbose`)).toBe("--password [REDACTED] --verbose");
  expect(lastMeaningfulLine(`DB_PASSWORD=${password}`)).toBe("");
});

test("round 2 finding 3: delimiters between separate pairs, commands and JSON fields are kept", () => {
  expect(redactSecrets("token=abc&page=2")).toBe("token=[REDACTED]&page=2");
  expect(redactSecrets("password=abc;user=bob")).toBe("password=[REDACTED];user=bob");
  expect(redactSecrets("export TOKEN=abc&&ls")).toBe("export TOKEN=[REDACTED]&&ls");
  expect(redactSecrets('{"token":abc,"x":1}')).toBe('{"token":[REDACTED],"x":1}');
  expect(redactSecrets("token=abc, then more")).toBe("token=[REDACTED], then more");
});

test("round 2 finding 10: lines beyond the redaction bound never leak and never throw", () => {
  const long = `${"a ".repeat(5000)}token=${VALUE}`;
  const out = lastMeaningfulLine(`${long}\nnext line`);
  expect(out).not.toContain(VALUE);
  const huge = `${"b".repeat(9000)}\nPASSWORD=${VALUE}`;
  expect(lastMeaningfulLine(huge)).not.toContain(VALUE);
});

function captureClient() {
  const asked: any[] = [];
  const client = { ask: async (state: any) => { asked.push(state); return { answers: {}, jevMs: 1, model: "m" }; } } as any;
  return { asked, client };
}

const CLASSIFY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["--token", " "],
  ["--token", "\n"],
  ["--password", " "],
  ["password:", " "],
  ["password:", "\n"],
  ["API_KEY=", "\n"],
  ["Bearer", " "],
  ["Bearer", "\n"],
];

function paneTextCutAt(key: string, separator: string, cut: number): string {
  const block = `${key}${separator}${VALUE} `;
  const fillerLength = MAX_CLASSIFY_PANE_TEXT_CHARS - block.length + cut;
  const filler = "ab ".repeat(Math.ceil(fillerLength / 3)).slice(0, fillerLength);
  return `${"y".repeat(500)} ${block}${filler}`;
}

test("round 2 uncovered 6: a tail cut anywhere between a key and its value never sends the value", async () => {
  for (const [key, separator] of CLASSIFY_KEYS) {
    const span = key.length + separator.length + VALUE.length + 1;
    for (let cut = 0; cut < span; cut++) {
      const paneText = paneTextCutAt(key, separator, cut);
      const tail = paneText.slice(-MAX_CLASSIFY_PANE_TEXT_CHARS);
      expect(tail.startsWith(`${key}${separator}${VALUE} `.slice(cut))).toBe(true);
      const { asked, client } = captureClient();
      await classifyPaneText({ paneText, agent: "codex", status: "idle" }, client);
      expect(asked).toHaveLength(1);
      expect(asked[0].paneText, `${key}|${JSON.stringify(separator)}|${cut}`).not.toContain(VALUE);
      expect(asked[0].paneText.length).toBeLessThanOrEqual(MAX_CLASSIFY_PANE_TEXT_CHARS);
    }
  }
});

test("round 2 uncovered 6: the tail is still sent when no key is cut", async () => {
  const paneText = `${"line of ordinary output\n".repeat(400)}final status line\n`;
  const { asked, client } = captureClient();
  await classifyPaneText({ paneText, agent: "codex", status: "idle" }, client);
  expect(asked[0].paneText.endsWith("final status line\n")).toBe(true);
  expect(asked[0].paneText.length).toBeGreaterThan(5000);
  expect(asked[0].paneText.length).toBeLessThanOrEqual(MAX_CLASSIFY_PANE_TEXT_CHARS);
});

test("round 2 uncovered 6: a wrapped key and value inside the window are redacted before the tail is cut", async () => {
  const filler = "line of ordinary output\n".repeat(300);
  const paneText = `${filler}run --token\n${VALUE} --verbose\nfinal status line\n${"more output\n".repeat(50)}`;
  const { asked, client } = captureClient();
  await classifyPaneText({ paneText, agent: "codex", status: "idle" }, client);
  expect(asked[0].paneText).not.toContain(VALUE);
  expect(asked[0].paneText).toContain("final status line");
  expect(asked[0].paneText.length).toBeLessThanOrEqual(MAX_CLASSIFY_PANE_TEXT_CHARS);
});
