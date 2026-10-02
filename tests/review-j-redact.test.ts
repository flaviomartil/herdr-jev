import { expect, test } from "bun:test";
import { ANSI_PATTERN, lastMeaningfulLine, redactSecrets } from "../src/herdr/pane-text.ts";
import { normalizePaneText } from "../src/herdr/client.ts";
import { formatDailyMarkdown, formatDailyText } from "../src/herdr/daily.ts";

const BASE64_SECRET = "QWxhZGRpbjpvcGVu" + "IHNlc2FtZQ9x8y7z6w5v4u3t2s1r";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const GITLAB_TOKEN = "glpat-" + "abcdefghij0123456789";
const BEARER_VALUE = "abcd1234" + "efgh5678";
const ESC = "\x1b";
const BEL = "\x07";

test("finding 1: a base64 secret followed by a semicolon, colon or angle bracket is redacted", () => {
  for (const next of [";", ":", "<", ",", ")"]) {
    const out = redactSecrets(`value ${BASE64_SECRET}${next}tail`);
    expect(out).not.toContain(BASE64_SECRET);
    expect(out).toBe(`value [REDACTED]${next}tail`);
  }
  expect(lastMeaningfulLine(`copied ${BASE64_SECRET};done`)).toBe("copied [REDACTED];done");
});

test("finding 2: a quoted value with no closing quote is redacted", () => {
  expect(redactSecrets('export API_KEY="hunter2abc')).toBe('export API_KEY="[REDACTED]');
  expect(redactSecrets("password='hunter2")).toBe("password='[REDACTED]");
  expect(redactSecrets('run --password "abc')).toBe('run --password "[REDACTED]');
  expect(redactSecrets("run --token 'abc def")).toBe("run --token '[REDACTED]");
  expect(redactSecrets('{"api_key": "abc def ghi')).toBe('{"api_key": "[REDACTED]');
  expect(redactSecrets('first line\nsecret: "abc def\nnext line')).toBe('first line\nsecret: "[REDACTED]\nnext line');
  expect(lastMeaningfulLine('export API_KEY="hunter2abc')).toBe('export API_KEY="[REDACTED]');
});

test("finding 2: closed quoted values keep their closing quote and the text after them", () => {
  expect(redactSecrets('export API_KEY="hunter2abc" && ls')).toBe('export API_KEY="[REDACTED]" && ls');
  expect(redactSecrets("password='a b c' next")).toBe("password='[REDACTED]' next");
  expect(redactSecrets('run --password "abc def" now')).toBe('run --password "[REDACTED]" now');
  expect(redactSecrets('say "it\'s" then token="a\\"b" end')).toBe('say "it\'s" then token="[REDACTED]" end');
});

test("finding 4: private CSI, intermediate bytes, non CSI escapes, unterminated OSC, BEL and lone CR are stripped", () => {
  const samples = [
    `${ESC}[>4;2mhello`,
    `${ESC}[2 qhello`,
    `${ESC}(Bhello`,
    `${ESC}chello`,
    `${ESC}]0;window title${BEL}hello`,
    `${ESC}]0;window title${ESC}\\hello`,
    `${ESC}]0;unterminated title\nhello`,
    `${ESC}Pdcs payload${ESC}\\hello`,
    `${BEL}hel${BEL}lo`,
    `${ESC}[31;1mhello${ESC}[0m`,
    `${ESC}[?25lhello${ESC}[?25h`,
    `hello${ESC}`,
    `${ESC}\nhello`,
  ];
  for (const sample of samples) {
    const out = lastMeaningfulLine(sample);
    expect(out).toBe("hello");
    expect(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(out)).toBe(false);
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(normalizePaneText(sample))).toBe(false);
  }
});

test("finding 4: a lone carriage return splits lines instead of gluing text", () => {
  expect(lastMeaningfulLine("progress 10%\rprogress 20%\rwork finished")).toBe("work finished");
  expect(lastMeaningfulLine("first\r\nsecond")).toBe("second");
});

test("finding 4: the ANSI pattern removes control bytes but keeps tab and newline", () => {
  expect("a\tb\nc".replace(ANSI_PATTERN, "")).toBe("a\tb\nc");
  expect(`a${BEL}b${ESC}[>4;2mc`.replace(ANSI_PATTERN, "")).toBe("abc");
});

test("finding 4: the daily report does not carry terminal escapes from pane content or commit subjects", () => {
  const dirty = `ok${ESC}[>4;2m${ESC}]0;title${BEL}${ESC}(B${BEL}done${ESC}c`;
  const report = {
    date: new Date("2026-10-01T12:00:00Z"),
    projects: [
      {
        project: "proj",
        branch: "main",
        commitsCount: 1,
        commitSubjects: [dirty],
        uncommittedCount: 0,
        agents: [
          {
            project: "proj",
            agent: "codex",
            handle: "worker",
            model: "gpt-6.1-sol",
            state: "working",
            branch: "main",
            cwd: "/x",
            commitsCount: 1,
            commitSubjects: [dirty],
            uncommittedCount: 0,
            runSummary: null,
            lastLine: dirty,
            paneId: "p1",
            tarefa: null,
          },
        ],
      },
    ],
  };
  for (const text of [formatDailyText(report), formatDailyMarkdown(report)]) {
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)).toBe(false);
    expect(text).toContain("okdone");
  }
});

test("finding 5: the tail of a wrapped secret is not shown when the continuation has more words", () => {
  const wrapped = 'curl -H "X-Api-Key: abcd\nefgh" https://example.com';
  const out = lastMeaningfulLine(wrapped);
  expect(out).not.toContain("efgh");
  expect(out).not.toContain("abcd");

  const unquoted = "run --token abcd\nefgh --verbose";
  expect(lastMeaningfulLine(unquoted)).not.toContain("efgh");

  const boxed = '│ curl -H "X-Api-Key: abcd │\n│ efgh" https://example.com │';
  expect(lastMeaningfulLine(boxed)).not.toContain("efgh");
});

test("finding 6: 200 KB of adversarial input is redacted within 500 ms", () => {
  const size = 200_000;
  const shapes: Record<string, string> = {
    dashes: "a-".repeat(size / 2),
    dots: "a.".repeat(size / 2),
    keywords: "token".repeat(size / 5),
    flags: "--x".repeat(size / 3),
    flagKeyword: "--token".repeat(size / 7),
    colons: "a:".repeat(size / 2),
    urls: "http://a:".repeat(size / 9),
    bearer: "Bearer ".repeat(size / 7),
    plus: "1a+".repeat(size / 3) + "_",
    quotes: 'token="'.repeat(size / 7),
    spaces: `token${" ".repeat(size)}`,
    tilde: "a~1".repeat(size / 3),
    letters: "a".repeat(size),
  };
  for (const [name, input] of Object.entries(shapes)) {
    const started = performance.now();
    const out = redactSecrets(input);
    const elapsed = performance.now() - started;
    expect(typeof out).toBe("string");
    expect(out.length).toBeLessThanOrEqual(input.length + 64);
    expect(`${name}:${elapsed < 500}`).toBe(`${name}:true`);
  }
});

test("finding 6: input beyond the bound is truncated without leaving the head of a partial token", () => {
  const filler = "word ".repeat(1700);
  const out = redactSecrets(`${filler}${BASE64_SECRET}`);
  expect(out.length).toBeLessThanOrEqual(8192);
  expect(out).not.toContain(BASE64_SECRET.slice(0, 20));
  const cutInsideToken = redactSecrets(`${"x ".repeat(4090)}${"A1".repeat(100)}`);
  expect(cutInsideToken).not.toContain("A1A1A1A1A1");
});

test("finding 17: gitlab tokens and lowercase bearer values are redacted", () => {
  expect(redactSecrets(`push with ${GITLAB_TOKEN} now`)).toBe("push with [REDACTED] now");
  expect(redactSecrets(`curl -H 'authorization: bearer ${BEARER_VALUE}'`)).toBe("curl -H 'authorization: bearer [REDACTED]'");
  expect(redactSecrets("the bearer of news")).toBe("the bearer of news");
});

test("redaction keeps ordinary text, paths and host:port URLs intact", () => {
  const text = "Ran /home/user/projects/app/src/index.ts and fetched https://example.com:8080/docs for review";
  expect(redactSecrets(text)).toBe(text);
  expect(redactSecrets("postgres://user:pa/ss@host:5432/db")).toBe("postgres://user:[REDACTED]@host:5432/db");
  expect(redactSecrets(`id\t${AWS_KEY}`)).toBe("id\t[REDACTED]");
});
