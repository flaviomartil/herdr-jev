import { describe, expect, test } from "bun:test";
import { formatCouncilSummary } from "../src/council/format.js";
import { normalizeSeverity, synthesize } from "../src/council/synth.js";
import { redact, safe, safeBlock } from "../src/council/text.js";
import type { CouncilRun } from "../src/council/types.js";
import { fakeJev, finding } from "./council-synth-support.js";

const j = (...parts: string[]) => parts.join("");
const PW = j("Pa55word", "-Value");
const PW16 = j("correct-horse-", "staple9");
const TOK = j("abc123", "XYZ456", "def789");
const KEY20 = j("abcd1234", "efgh5678ijkl");
const AWS = j("/K7MDENGbPxRfiCYEXAMPLE", "KEYwJalrXUtnFEMI");

const okRun: CouncilRun = {
  diffHash: "h",
  ran: true,
  members: [{ member: "codex", status: "done", findings: [], durationMs: 1000 }],
};

const labelled: [string, string, string][] = [
  ["control", PW, `Hardcoded DB_PASSWORD=${PW} in .env.example`],
  ["label", PW, `Evidence: DB_PASSWORD=${PW} in .env.example`],
  ["note", KEY20, `Note: api_key=${KEY20} is committed`],
  ["file:line", PW, `.env:12: DB_PASSWORD=${PW}`],
  ["line N", TOK, `line 12: API_TOKEN=${TOK}`],
  ["url ?token", TOK, `The webhook https://example.com/hook?token=${TOK} is logged`],
  ["url &api_key", KEY20, `GET https://api.example.com/v1/items?page=2&api_key=${KEY20} returns 200`],
  ["url access_token", TOK, `callback_url = https://example.com/cb?access_token=${TOK}`],
  ["flattened yaml", PW16, `database: password: ${PW16}`],
  ["flattened yaml quoted", PW16, `db: password: "${PW16}"`],
  ["file label quoted key", PW16, j('settings.json: "pass', 'word": "', PW16, '"')],
  ["env label", "Zx9Kq2Lm7Vt4Rb8N", "env: MINIO_ACCESS_KEY=Zx9Kq2Lm7Vt4Rb8N"],
  ["semicolon prefix", PW, `MODE=production;DB_PASSWORD=${PW}`],
  ["export after label", PW, `Fix: export DB_PASSWORD=${PW}`],
  ["equals label", PW, `expected = DB_PASSWORD=${PW}`],
];

const flags: [string, string, string][] = [
  ["boolean flag before secret flag", TOK, `script runs deploy --force --token ${TOK} in CI`],
  ["two flags", PW, `docker login --quiet --password ${PW} registry`],
];

describe("keyed rule after a non-secret key", () => {
  test("none of the 15 labelled forms leaks", () => {
    const leaked = labelled.filter(([, secret, text]) => safe(text, 800).includes(secret)).map(([l]) => l);
    expect(labelled.length).toBe(15);
    expect(leaked).toEqual([]);
  });

  test("none of the flag cases leaks", () => {
    const leaked = flags.filter(([, secret, text]) => safe(text, 800).includes(secret)).map(([l]) => l);
    expect(leaked).toEqual([]);
  });

  test("a rejected match does not hide a following secret assignment", () => {
    expect(redact(`level=debug_mode_on_now token=${TOK}`)).toBe("level=debug_mode_on_now token=[REDACTED]");
    expect(redact(`name: ${PW} password=${PW16}`)).toContain("password=[REDACTED]");
  });

  test("a long unquoted value is redacted to the end of the run", () => {
    const long = j("Ab1+", "/x").repeat(120);
    expect(redact(`api_secret=${long} trailing`)).toBe("api_secret=[REDACTED] trailing");
  });

  test("a long quoted value is redacted whole", () => {
    const body = "Q".repeat(2960);
    expect(redact(`password: "${body}z9" trailing`)).toBe("password: [REDACTED] trailing");
  });

  test("scanning stays linear on key-heavy input", () => {
    for (const input of ["a=b ".repeat(4000), "x: ".repeat(5300), "token: 1 ".repeat(1800), "--a ".repeat(4000)]) {
      const start = performance.now();
      redact(input);
      expect(performance.now() - start).toBeLessThan(5000);
    }
  });
});

describe("comparison operators", () => {
  test("a comparison with a quoted literal is redacted", () => {
    expect(redact('if (password === "S3cr3tAdmin!") grants admin')).toContain("[REDACTED]");
    expect(redact('if (secret !== "S3cr3tAdmin!") deny')).toContain("[REDACTED]");
  });

  test("a comparison with an unquoted value is kept", () => {
    for (const text of ["if (token === expectedToken1234567890) ok", "secret !== Summer2024!", "password == Winter2024x"]) {
      expect(redact(text)).toBe(text);
    }
  });

  test("assignment operators redact unquoted credential-looking values", () => {
    expect(redact("password := Summer2024!")).toBe("password := [REDACTED]");
    expect(redact("'password' => 'Summer2024!'")).toBe("'password' => [REDACTED]");
    expect(redact("'password' => Summer2024!")).toBe("'password' => Summer2024!");
  });
});

describe("newline as a separator", () => {
  test("a value on the next line is redacted in block text", () => {
    expect(redact(`password:\n  ${PW}`)).toBe("password:\n  [REDACTED]");
    expect(redact(`config:\n  api_key =\n    ${KEY20}\nend`)).toBe("config:\n  api_key =\n    [REDACTED]\nend");
    expect(safeBlock(`secret:\n  ${PW16}`, 500)).not.toContain(PW16);
  });

  test("a non-secret key before a newline keeps the next line", () => {
    const text = `name:\n  ${PW}`;
    expect(redact(text)).toBe(text);
  });

  test("an unindented next line is not a value", () => {
    const text = `password:\n${PW}`;
    expect(redact(text)).toBe(text);
  });

  test("the Jev payload and the structured detail never carry it", async () => {
    const jev = fakeJev();
    const out = await synthesize([finding("A", "codex", { detail: `password:\n  ${PW16}\nmore` })], { jev });
    expect(JSON.stringify(jev.calls)).not.toContain(PW16);
    expect(JSON.stringify(out)).not.toContain(PW16);
    expect(formatCouncilSummary(out, okRun)).not.toContain(PW16);
  });
});

describe("follow-up redaction rules", () => {
  test("a base64 key starting with a slash is not a file path", () => {
    expect(redact(`aws_secret_access_key=${AWS}`)).toBe("aws_secret_access_key=[REDACTED]");
    expect(redact("password_file=/run/secrets/db_password")).toBe("password_file=/run/secrets/db_password");
  });

  test("a redis url with an empty user loses its password", () => {
    expect(redact(`redis://:${PW}@redis:6379/0`)).toBe("redis://:[REDACTED]@redis:6379/0");
  });

  test("a dotted value is exempt only when every segment is a plain identifier", () => {
    expect(redact("password=Summertime.Wintertime!")).toBe("password=[REDACTED]");
    expect(redact("secret=process.env.JWT_SECRET!.trim()")).toBe("secret=process.env.JWT_SECRET!.trim()");
    expect(redact("token=config.auth.value")).toBe("token=config.auth.value");
    expect(redact("token=a1b2c3.d4e5f6.g7h8i9")).toBe("token=[REDACTED]");
  });

  test("Basic needs a long credential or an Authorization header", () => {
    expect(redact("Basic TypeScript generics")).toBe("Basic TypeScript generics");
    expect(redact("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [REDACTED]");
    expect(redact("Basic dXNlcjpwYXNzd29yZDEyMw==")).toBe("Basic [REDACTED]");
  });

  test("the sk- shape needs digits, 20 characters and no file extension", () => {
    expect(redact("see docs/sk-learn-pipeline-example.ipynb")).toBe("see docs/sk-learn-pipeline-example.ipynb");
    expect(redact("see sk-learn-pipeline-example2-notebook.ipynb")).toBe("see sk-learn-pipeline-example2-notebook.ipynb");
    expect(redact(`key ${j("s", "k-", "proj1234567890abcdefghij")} end`)).toBe("key [REDACTED] end");
    expect(redact(`key ${j("s", "k-", "proj1234567890abcdefghij")}. end`)).toBe("key [REDACTED]. end");
  });

  test("severity lookup ignores inherited properties", () => {
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(normalizeSeverity(word)).toBe("medium");
    }
  });

  test("input beyond the raw bound is discarded before redaction", () => {
    const text = "x".repeat(40) + " " + "y".repeat(100_000) + ` password=${PW}`;
    const out = safe(text, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).not.toContain("password");
  });
});

describe("redaction reaches a fixed point", () => {
  test("random compositions are stable after one call", () => {
    let state = 123456789;
    const next = () => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
      return state;
    };
    const parts = [
      "password", "token", "api_key", "secret", "Basic ", "Bearer ", "Authorization: ", "--password ", "--token ",
      "=", ":", " := ", " === ", " => ", '"', "'", "\n  ", " ", "\n", ";", "&", "?", "@", "://", "postgres", "redis", ":",
      PW, PW16, TOK, KEY20, AWS, "undefined", "null", "Summer2024!", "abc.def.ghi", "/run/secrets/x", "sk-", "ghp_",
      "[REDACTED]", "-----BEGIN PRIVATE KEY-----", "Zk3Qp9Lm2Xv7Rt5Yb8Nc1Hd4Gf6Js0WqAa", "0123456789abcdef0123456789abcdef", "commit ",
    ];
    for (let i = 0; i < 60000; i++) {
      const len = 2 + (next() % 9);
      let text = "";
      for (let k = 0; k < len; k++) text += parts[next() % parts.length]!;
      const once = redact(text);
      expect(redact(once)).toBe(once);
    }
  });
});
