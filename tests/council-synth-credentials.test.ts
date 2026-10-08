import { describe, expect, test } from "bun:test";
import { formatCouncilSummary } from "../src/council/format.js";
import { normalizeSeverity, synthesize } from "../src/council/synth.js";
import { redact, safe, pathText, place } from "../src/council/text.js";
import type { CouncilRun } from "../src/council/types.js";
import { fakeJev, finding } from "./council-synth-support.js";

const okRun: CouncilRun = {
  diffHash: "h",
  ran: true,
  members: [{ member: "codex", status: "done", findings: [], durationMs: 1000 }],
};

const j = (...parts: string[]) => parts.join("");

interface Shape {
  label: string;
  secret: string;
  text: (secret: string) => string;
}

const B62 = "Zk3Qp9Lm2Xv7Rt5Yb8Nc1Hd4Gf6Js0WqAaUuEeIiOo";
const lowDigit = "QwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUi7o";

const shapes: Shape[] = [
  { label: "github classic pat", secret: j("gh", "p_", B62.slice(0, 36)), text: (s) => `Hardcoded token ${s} in config.ts` },
  { label: "github fine-grained pat", secret: j("github", "_pat_", B62.slice(0, 22), "_", B62.slice(0, 30)), text: (s) => `token ${s} committed` },
  { label: "gitlab pat", secret: j("gl", "pat-", B62.slice(0, 20)), text: (s) => `CI uses ${s}` },
  { label: "openai-style key", secret: j("s", "k-", "proj-", B62.slice(0, 40)), text: (s) => `key ${s} in .env.example` },
  { label: "anthropic-style key", secret: j("s", "k-", "ant-api03-", B62.slice(0, 40)), text: (s) => `key ${s} in test` },
  { label: "slack bot token", secret: j("xo", "xb-", "123456789012-1234567890123-", B62.slice(0, 24)), text: (s) => `slack ${s}` },
  { label: "aws access key id", secret: j("AK", "IA", "IOSFODNN7EXAMPLE"), text: (s) => `aws id ${s} in terraform` },
  { label: "jwt", secret: j("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"), text: (s) => `test fixture embeds ${s}` },
  { label: "pem private key", secret: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", text: (s) => `key file has -----BEGIN PRIVATE KEY----- ${s} -----END PRIVATE KEY----- committed` },
  { label: "bearer header (token with digit)", secret: "abc123def456ghi789jkl", text: (s) => `curl sends Authorization: Bearer ${s} to staging` },
  { label: "hex 32 (md5-like api key)", secret: "9f86d081884c7d659a2feaa0c55ad015", text: (s) => `the key ${s} is in fixtures` },
  { label: "hex 40 bare", secret: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b", text: (s) => `legacy token ${s} is still valid` },
  { label: "alnum 40 mixed", secret: B62.slice(0, 40), text: (s) => `value ${s} looks like a live key` },
  { label: "quoted password, unquoted key", secret: "hunter2hunter2", text: (s) => `config has password: "${s}" in defaults` },
  { label: "unquoted 20-char value", secret: "abcd1234efgh5678ijkl", text: (s) => `api_key=${s} in the compose file` },

  { label: "env line, short unquoted password", secret: "Summer2024!", text: (s) => `Hardcoded credential DB_PASSWORD=${s} in .env.example` },
  { label: "yaml, short unquoted password", secret: "hunter2", text: (s) => `docker-compose sets password: ${s} for the admin user` },
  { label: "json, quoted key", secret: "hunter2hunter2", text: (s) => `settings.json contains "password": "${s}"` },
  { label: "php array, quoted key and =>", secret: "S3cretValue99", text: (s) => `config/packages has 'password' => '${s}'` },
  { label: "comparison with a literal", secret: "S3cr3tAdmin!", text: (s) => `Backdoor: if (password === "${s}") grants admin` },
  { label: "bracket key", secret: "tok_live_abc123XYZ", text: (s) => `process.env["API_TOKEN"] = "${s}" in the test setup` },
  { label: "connection string userinfo", secret: "hunter2pw", text: (s) => `RECAST_DB_URL=postgres://recast:${s}@db.internal:5432/recast is committed` },
  { label: "symfony DATABASE_URL", secret: "ChangeMe99", text: (s) => `DATABASE_URL="mysql://app:${s}@127.0.0.1:3306/app" in .env` },
  { label: "https url userinfo", secret: "p4ssw0rdValue", text: (s) => `git remote uses https://deploy:${s}@github.com/acme/app.git` },
  { label: "basic auth header", secret: "dXNlcjpwYXNzd29yZDEyMw==", text: (s) => `request has Authorization: Basic ${s}` },
  { label: "aws secret access key in prose", secret: j("wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCYEXAMPLEKEY"), text: (s) => `the secret key ${s} is in the terraform state` },
  { label: "aws secret access key assignment", secret: j("wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCYEXAMPLEKEY"), text: (s) => `aws_secret_access_key = ${s}` },
  { label: "azure storage AccountKey", secret: j("Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq", "/K1SZFPTOtr/KBHBeksoGMGw=="), text: (s) => `connection string has AccountKey=${s};EndpointSuffix=core.windows.net` },
  { label: "slack webhook url", secret: j("T00000000/B00000000/", "XXXXXXXXXXXXXXXXXXXXXXXX"), text: (s) => `posts to https://hooks.slack.com/services/${s}` },
  { label: "stripe live key", secret: j("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"), text: (s) => `stripe key ${s} in checkout.ts` },
  { label: "google api key", secret: j("AI", "za", "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"), text: (s) => `maps key ${s} is in the bundle` },
  { label: "alnum 36 with fewer than 3 digits", secret: lowDigit, text: (s) => `session signing key ${s} is hardcoded` },
  { label: "lowercase+digit 36 (uuid-less token)", secret: "k3j4h5g6f7d8s9a0q1w2e3r4t5y6u7i8o9p0", text: (s) => `deploy key ${s} in the workflow file` },
  { label: "ACCESS_KEY name not in list", secret: "Zx9Kq2Lm7Vt4Rb8N", text: (s) => `MINIO_ACCESS_KEY=${s} in compose` },
  { label: "cli flag", secret: "Pa55word-Value", text: (s) => `script runs mysql --password ${s} in CI logs` },
  { label: "private key without END (clipped upstream)", secret: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", text: (s) => `file has -----BEGIN RSA PRIVATE KEY----- ${s}` },
];


const SHA = j("24483e4d5c1a2b3c4d5e", "6f708192a3b4c5d6e7f8");

const prose = [
  "Token is logged in plaintext at info level",
  "Missing check: token === undefined is never handled in verify()",
  "password: stored in plaintext in the users table, hash it with argon2",
  "apiKey = process.env.KEY ?? 'test-key' falls back to a hardcoded key in production",
  "if (secret !== expected) return 401; uses a non constant-time comparison",
  "const token = await getToken(req); the result is never awaited by the caller in upload.ts",
  "Authorization: Bearer abc.def.ghi is forwarded to the third-party webhook",
  "bearer token leaks through the redirect URL",
  `Regression introduced in ${SHA}, revert the hunk`,
  "resolveTypeSafeApiKey() is called once per batch and blocks the event loop",
  "credentials: 'include' is set on a cross-origin fetch without CSRF protection",
  "Off-by-one in pagination loop skips the last page",
  "user:pass@host style URL is built without encoding",
  "The retry loop ignores AbortSignal; secret rotation is unaffected",
  "token: expired tokens are accepted because exp is compared in seconds",
  "password = req.body.password is used without trimming",
  "The secret: it is read from process.env.SESSION_SECRET at import time",
  "api_key=undefined when the env var is missing, so every request is anonymous",
  "token = null resets the session but the cookie survives",
  "const apiKey = config.get('typesafe.apiKey') is evaluated per request",
  "credential: none is passed to the S3 client in tests",
  "Authorization: header is dropped by the proxy on redirect",
  "authorization = `Bearer ${token}` is built before token is checked",
  "password: z.string().min(8) allows whitespace-only passwords",
  "secret=process.env.JWT_SECRET!.trim() throws when the variable is unset",
  "token: string | undefined is narrowed incorrectly in refresh()",
  "passwordHash: bcrypt.hashSync(password, 4) uses a cost factor of 4",
  "api-key: see docs/configuration.md#api-keys for the expected format",
  "sets token = generateSessionToken(user.id, Date.now())",
  "the 'token' === 'token' comparison in line 9 is always true",
  `Introduced in commit ${SHA} by the refactor`,
  `rev: ${SHA}`,
  "requestId 550e8400-e29b-41d4-a716-446655440000 is logged twice",
  "https://example.com/docs/authentication/bearer-tokens-and-refresh-flow-v2 is the wrong link",
  "see src/auth/token.ts:42 and credentials.service.ts:7",
  "see src/config/secrets.ts:120:15 and token.ts:42-57",
  "max_tokens=4096 is hardcoded; token_budget: 14000 chars",
  "token: RS256/ES256 are accepted but HS256 is not rejected",
  "secret: sha256(secret + salt) is used instead of an HMAC",
  "token: base64 encoded but not signed",
  "password: argon2id is recommended over bcrypt2y",
  "secret: 256-bit keys are truncated to 128-bit",
  "password: min 8 chars is enforced client-side only",
  "token: 1 hour expiry is never checked",
  "Basic authentication is accepted over plain HTTP",
  "Basic Auth2 fallback is enabled",
  "http://localhost:3000/@me returns 500",
  "fetches https://api.example.com:8443/v1/users without a timeout",
  "git clone ssh://git@github.com:22/acme/app.git fails in CI",
  "mailto:ops@example.com is hardcoded in the footer",
  "--password is deprecated, use --password-file /run/secrets/db",
  "--token-ttl 3600 is ignored when --no-cache is set",
  "the error is \"invalid token\": the client retries forever",
  "password_file: /run/secrets/db_password is world-readable",
];



const REDACTED_PROSE = new Map<string, string>([
  [
    "apiKey = process.env.KEY ?? 'test-key' falls back to a hardcoded key in production",
    "apiKey = process.env.KEY ?? [REDACTED] falls back to a hardcoded key in production",
  ],
]);

const RESIDUAL = new Set([
  "yaml, short unquoted password",
  "aws secret access key in prose",
  "slack webhook url",
  "alnum 36 with fewer than 3 digits",
  "lowercase+digit 36 (uuid-less token)",
]);

describe("council redactor, credential shapes and prose", () => {
  test("every credential shape outside the documented residuals is redacted", () => {
    const leaked = shapes.filter((s) => safe(s.text(s.secret), 600).includes(s.secret)).map((s) => s.label);
    expect(leaked.filter((l) => !RESIDUAL.has(l))).toEqual([]);
    expect(shapes.length).toBe(36);
    expect(leaked.length).toBeLessThanOrEqual(RESIDUAL.size);
  });

  test("no prose sample is changed", () => {
    const changed = prose.filter((p) => safe(p, 600) !== (REDACTED_PROSE.get(p) ?? p));
    expect(changed).toEqual([]);
    expect(prose.length).toBe(54);
    expect(REDACTED_PROSE.size).toBe(1);
  });

  test("a quoted literal after a fallback operator is redacted when the target is secret-named", () => {
    expect(redact('const password = process.env.DB_PASSWORD || "Sup3rSecretPw"')).toBe("const password = process.env.DB_PASSWORD || [REDACTED]");
    expect(redact("token: cfg.token ?? 'abcd-1234-efgh'")).toBe("token: cfg.token ?? [REDACTED]");
    expect(redact('const name = process.env.NAME || "default-name"')).toBe('const name = process.env.NAME || "default-name"');
  });

  test("the sk- shape is linear in the length of the run", () => {
    const started = Date.now();
    const long = `sk-${"z".repeat(200_000)}`;
    expect(redact(long)).toBe(long);
    expect(redact(`${long}1`)).toBe("[REDACTED]");
    expect(redact(`key sk-proj-${"ab1".repeat(10)}.json`)).toBe(`key sk-proj-${"ab1".repeat(10)}.json`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("redacting twice equals redacting once on the prose and credential sets", () => {
    const inputs = [...prose, ...shapes.map((s) => s.text(s.secret))];
    for (const input of inputs) {
      const once = redact(input);
      expect(redact(once)).toBe(once);
    }
  });

  test("the keyed rule redacts a value only above its floors", () => {
    expect(redact("api_key=abcd1234efgh567")).toBe("api_key=abcd1234efgh567");
    expect(redact("api_key=abcd1234efgh5678")).toBe("api_key=[REDACTED]");
    expect(redact("DB_PASSWORD=Summer2024!")).toBe("DB_PASSWORD=[REDACTED]");
    expect(redact("token=4096")).toBe("token=4096");
    expect(redact("token=RS256")).toBe("token=RS256");
    expect(redact("secret=argon2id")).toBe("secret=argon2id");
  });

  test("identifiers, keywords and bare words are not credentials", () => {
    for (const text of [
      "token = undefined",
      "password: null",
      "secret: includeSomething",
      "token === undefined",
      "credentials: 'include'",
      "password: 'password'",
      "token: process.env.TOKEN_VALUE",
      "secret=process.env.JWT_SECRET!.trim()",
      "password_file: /run/secrets/db_password",
      "max_tokens=4096",
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  test("mixed-case alphanumeric runs need three digits and 32 characters", () => {
    const letters = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf";
    const two = letters.slice(0, 30) + "12";
    const three = letters.slice(0, 29) + "123";
    expect(redact(`value ${two} end`)).toBe(`value ${two} end`);
    expect(redact(`value ${three} end`)).toBe("value [REDACTED] end");
  });

  test("URL userinfo loses only the password", () => {
    expect(redact("postgres://recast:pw@db/recast")).toBe("postgres://recast:[REDACTED]@db/recast");
    expect(redact("https://example.com:8443/v1")).toBe("https://example.com:8443/v1");
  });

  test("a PEM header in prose survives, a block does not", () => {
    const prose1 = "The file starts with -----BEGIN PRIVATE KEY----- and is checked in somewhere";
    expect(redact(prose1)).toBe(prose1);
    const block = `-----BEGIN PRIVATE KEY-----\n${"MIIEvQIBADANBgkq".repeat(5)}\n-----END PRIVATE KEY----- trailing words`;
    const out = redact(block);
    expect(out).toBe("[REDACTED] trailing words");
    const open = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIEvQIBADANBgkq".repeat(5)}`;
    expect(redact(open)).toBe("[REDACTED]");
  });

  test("invisible splitters cannot hide a token", () => {
    const tok = "ghp" + "_" + "Zk3Qp9Lm2Xv7Rt5Yb8Nc1Hd4Gf6Js0WqAa";
    const half = tok.length >> 1;
    for (const code of [0xe0041, 0xfe0f, 0x34f, 0x61c, 0x3164, 0x200b, 0x202e, 0xe0100]) {
      const out = safe(`x ${tok.slice(0, half)}${String.fromCodePoint(code)}${tok.slice(half)} y`, 300);
      expect(out).toBe("x [REDACTED] y");
    }
  });
});

describe("council redactor cost and bounds", () => {
  test("pathological inputs redact in linear time", () => {
    const inputs = ["token.".repeat(200_000 / 6), "a.".repeat(100_000), "--" + "token-".repeat(33_000), "x://a:b ".repeat(25_000)];
    for (const input of inputs) {
      const start = performance.now();
      redact(input);
      expect(performance.now() - start).toBeLessThan(5000);
    }
  });

  test("input is clipped before redaction", () => {
    const huge = "token.".repeat(200_000);
    const start = performance.now();
    const out = safe(huge, 4000);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  test("synthesis of oversized details stays fast and bounded", async () => {
    const list = Array.from({ length: 5 }, (_, i) =>
      finding("T" + i, "codex", { detail: "token.".repeat(200_000), path: `src/${i}.ts` }),
    );
    const start = performance.now();
    const out = await synthesize(list, { jev: fakeJev() });
    expect(performance.now() - start).toBeLessThan(5000);
    for (const item of out.unique) expect(item.findings[0]!.detail.length).toBeLessThanOrEqual(4000);
  });
});

describe("council path and summary handling", () => {
  const GH = "ghp" + "_" + "Zk3Qp9Lm2Xv7Rt5Yb8Nc1Hd4Gf6Js0WqAa";

  test("a path gets prefix shapes only", () => {
    expect(pathText("src/auth/token.ts", 200)).toBe("src/auth/token.ts");
    expect(pathText(`config/${GH}/settings.ts`, 200)).toBe("config/[REDACTED]/settings.ts");
    expect(place("src/secrets.ts", 120, 200)).toBe("src/secrets.ts:120");
  });

  test("a token in the path never reaches Jev, the item or the text", async () => {
    const jev = fakeJev();
    const out = await synthesize([finding("harmless", "codex", { path: `config/${GH}/settings.ts`, line: 3 })], { jev });
    const text = formatCouncilSummary(out, okRun);
    expect(JSON.stringify(jev.calls)).not.toContain(GH);
    expect(JSON.stringify(out)).not.toContain(GH);
    expect(text).not.toContain(GH);
  });

  test("format redacts a summary that synthesize did not build", () => {
    const f = finding(`leaks ${GH}`, "codex", { detail: `token ${GH}` });
    const text = formatCouncilSummary(
      {
        agreements: [],
        disagreements: [],
        unique: [{ members: ["codex"], location: `src/${GH}.ts:1`, text: f.title, severity: "medium", findings: [f] }],
        notes: [],
        messages: [`Jev unavailable (401 ${GH})`],
        scoredBy: "none",
      },
      okRun,
    );
    expect(text).not.toContain(GH);
    expect(text).toContain("[REDACTED]");
  });

  test("Jev error text and the did-not-run note are redacted", async () => {
    const jev = fakeJev({ fail: () => new Error(`401 for ${GH}`) });
    const out = await synthesize([finding("A")], { jev });
    expect(out.messages.join(" ")).not.toContain(GH);
    const text = formatCouncilSummary(out, { diffHash: "h", ran: false, note: `skipped ${GH}`, members: [] });
    expect(text).not.toContain(GH);
    expect(text).toContain("Council did not run: skipped [REDACTED]");
  });

  test("the structured detail keeps its newlines while text is flattened", async () => {
    const out = await synthesize([finding("A", "codex", { detail: "line one\nline two" })], { jev: fakeJev() });
    expect(out.unique[0]!.findings[0]!.detail).toBe("line one\nline two");
    expect(formatCouncilSummary(out, okRun)).toContain('detail: "line one line two"');
  });

  test("severity words map onto the three levels, case-insensitively", () => {
    for (const [word, level] of [
      ["Critical", "high"], ["BLOCKER", "high"], ["major", "high"], ["error", "high"],
      ["Warning", "medium"], ["moderate", "medium"], ["medium", "medium"],
      ["minor", "low"], ["Info", "low"], ["nit", "low"], ["suggestion", "low"], ["LOW", "low"],
      ["weird", "medium"], [undefined, "medium"], [7, "medium"],
    ] as [unknown, string][]) {
      expect(normalizeSeverity(word)).toBe(level as never);
    }
  });

  test("inputs are not mutated", async () => {
    const list = [
      finding(`leaks ${GH}`, "codex", { detail: "a\nb", path: `src/${GH}.ts` }),
      { ...finding("B", "kimi", { path: "src/b.ts" }), severity: "Critical" as never },
    ];
    const before = JSON.stringify(list);
    await synthesize(list, { jev: fakeJev() });
    expect(JSON.stringify(list)).toBe(before);
  });

  test("the reduced-text message names findings scored on shortened requests", async () => {
    const jev = fakeJev();
    const big = finding("A", "codex", { detail: "q".repeat(300), path: `src/${"a".repeat(150)}.ts` });
    const out = await synthesize([big], { jev, limits: { maxChars: 450 } });
    expect(out.messages.join(" ")).toMatch(/1 finding\(s\) were scored on reduced text/);
  });

  test("the round 2 reduced-text message names groups checked on shortened requests", async () => {
    const mk = (title: string, member: "codex" | "kimi" | "antigravity", c: string) =>
      finding(title, member, { detail: "q".repeat(300), path: `src/${c.repeat(40)}.ts` });
    const jev = fakeJev({ same: (t) => (t === "B" || t === "C" ? "A" : "new") });
    const out = await synthesize([mk("A", "codex", "a"), mk("B", "kimi", "b"), mk("C", "antigravity", "c")], {
      jev,
      limits: { maxChars: 1200 },
    });
    const text = out.messages.join(" ");
    expect(text).toMatch(/1 group\(s\) were checked for contradiction on reduced text/);
    expect(text).not.toContain("finding(s) were scored on reduced text");
  });
});
