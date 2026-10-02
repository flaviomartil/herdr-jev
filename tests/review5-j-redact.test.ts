import { expect, test } from "bun:test";
import { lastMeaningfulLine, redactSecrets } from "../src/herdr/pane-text.ts";

const CLEAN = "building the project";

const REPORT_ROWS: ReadonlyArray<{ line: string; secret: string }> = [
  { line: 'password := "hunter2"', secret: "hunter2" },
  { line: "if ($password == 'hunter2') {", secret: "hunter2" },
  { line: "'db_password' => 'hunter2',", secret: "hunter2" },
  { line: "password: correct horse battery", secret: "correct horse battery" },
  { line: "PASSWORD=ab}cd", secret: "ab}cd" },
  { line: 'token=abc"def', secret: 'abc"def' },
];

for (const row of REPORT_ROWS) {
  test(`review 5 blocking: lastMeaningfulLine drops ${JSON.stringify(row.line)} and shows the previous clean line`, () => {
    expect(lastMeaningfulLine(row.line)).toBe("");
    expect(lastMeaningfulLine(`${CLEAN}\n${row.line}`)).toBe(CLEAN);
    expect(lastMeaningfulLine(`${CLEAN}\n${row.line}\n`)).toBe(CLEAN);
    expect(lastMeaningfulLine(`${CLEAN}\n│ ${row.line} │`)).toBe(CLEAN);
    expect(lastMeaningfulLine(`● ${CLEAN}\n${row.line}`)).toBe(CLEAN);
    expect(lastMeaningfulLine(`${CLEAN}\n${row.line}`)).not.toContain(row.secret.slice(0, 4));
  });

  test(`review 5 blocking: redactSecrets removes the whole value of ${JSON.stringify(row.line)}`, () => {
    const out = redactSecrets(row.line);
    expect(out).toContain("[REDACTED]");
    for (let i = 0; i + 4 <= row.secret.length; i++) {
      expect(out).not.toContain(row.secret.slice(i, i + 4));
    }
  });
}

test("review 5 blocking: operator forms are redacted for callers that redact", () => {
  expect(redactSecrets('password := "hunter2"')).toBe('password := "[REDACTED]"');
  expect(redactSecrets("if ($password == 'hunter2') {")).toBe("if ($password == '[REDACTED]') {");
  expect(redactSecrets("if ($token === 'hunter2') {")).toBe("if ($token === '[REDACTED]') {");
  expect(redactSecrets("'db_password' => 'hunter2',")).toBe("'db_password' => '[REDACTED]',");
  expect(redactSecrets("$cfg['secret'] = 'hunter2';")).toBe("$cfg['secret'] = '[REDACTED]';");
  expect(redactSecrets("password => hunter2")).toBe("password => [REDACTED]");
  expect(redactSecrets("password:=hunter2")).toBe("password:=[REDACTED]");
  expect(redactSecrets("token !== hunter2")).toBe("token !== [REDACTED]");
});

test("review 5 blocking: unquoted values with spaces, braces and quotes are redacted to the end of the value", () => {
  expect(redactSecrets("password: correct horse battery")).toBe("password: [REDACTED]");
  expect(redactSecrets("password = correct horse battery staple")).toBe("password = [REDACTED]");
  expect(redactSecrets("PASSWORD=ab}cd")).toBe("PASSWORD=[REDACTED]");
  expect(redactSecrets("PASSWORD=ab}}cd")).toBe("PASSWORD=[REDACTED]");
  expect(redactSecrets('token=abc"def')).toBe("token=[REDACTED]");
  expect(redactSecrets("token=abc'def ok")).toBe("token=[REDACTED] ok");
  expect(redactSecrets("my api key: hunter2 and more")).toBe("my api key: [REDACTED]");
  expect(redactSecrets("passwd: hunter2value")).toBe("passwd: [REDACTED]");
  expect(redactSecrets("credentials = hunter2value")).toBe("credentials = [REDACTED]");
});

test("review 5 blocking: braces and quotes that close a value are kept", () => {
  expect(redactSecrets("{token: abc}")).toBe("{token: [REDACTED]");
  expect(redactSecrets('{"token":abc}')).toBe('{"token":[REDACTED]}');
  expect(redactSecrets('{"token":"abc","x":1}')).toBe('{"token":"[REDACTED]","x":1}');
  expect(redactSecrets("token=abc, then more")).toBe("token=[REDACTED], then more");
});

test("review 5 blocking: lastMeaningfulLine never returns a line holding a keyword followed by a separator", () => {
  const lines = [
    "token:",
    "password =",
    "api key: ...",
    "Authorization: Token abc",
    "credential => x",
    "bearer abc",
    "passwd:=",
    "secret === x",
    "API-KEY = x",
    "Passphrase: x",
  ];
  for (const line of lines) {
    expect(lastMeaningfulLine(`${CLEAN}\n${line}`)).toBe(CLEAN);
  }
});

test("review 5 blocking: lines that merely mention a keyword are still shown", () => {
  expect(lastMeaningfulLine(`${CLEAN}\nrefreshing the token cache`)).toBe("refreshing the token cache");
  expect(lastMeaningfulLine(`${CLEAN}\nreading the password policy docs`)).toBe("reading the password policy docs");
  expect(lastMeaningfulLine("the bearer\nof news arrived")).toBe("of news arrived");
});

test("review 5 blocking: a literal redaction marker in a pane line is not shown", () => {
  expect(lastMeaningfulLine(`${CLEAN}\nsent [REDACTED] downstream`)).toBe(CLEAN);
});

test("review 5 blocking: a continuation of a dropped spaced value is not shown", () => {
  expect(lastMeaningfulLine(`${CLEAN}\npassword: correct horse\nbattery`)).toBe(CLEAN);
});

const KEYWORDS = ["password", "passwd", "secret", "token", "api_key", "API KEY", "db_password", "credentials"];
const OPERATORS = ["=", ":", ":=", "==", "=>"];
const VALUES = [
  "hunter2xyz",
  "correct horse battery",
  "ab}cd9",
  'abc"def7',
  "p@ss w0rd!",
  "x'yz12 tail",
  "Zx9;q&k,m",
  "s3cr3t-Value",
];
const WRAPS = ["bare", "spaced", "single", "double"] as const;

function generateCombos() {
  const combos: Array<{ line: string; value: string }> = [];
  let index = 0;
  for (const keyword of KEYWORDS) {
    for (const operator of OPERATORS) {
      const wrap = WRAPS[index % WRAPS.length];
      let value = VALUES[(index * 3 + 1) % VALUES.length];
      let line: string;
      if (wrap === "single" || wrap === "double") {
        const quote = wrap === "single" ? "'" : '"';
        value = value.replaceAll(quote, "");
        line = `${keyword} ${operator} ${quote}${value}${quote}`;
      } else if (wrap === "spaced") {
        line = `${keyword} ${operator} ${value}`;
      } else {
        value = value.split(/\s/)[0];
        line = `${keyword}${operator}${value}`;
      }
      combos.push({ line, value });
      index++;
    }
  }
  return combos;
}

function fourCharWindows(value: string): string[] {
  const windows: string[] = [];
  for (let i = 0; i + 4 <= value.length; i++) {
    const w = value.slice(i, i + 4);
    if (/\s/.test(w)) continue;
    windows.push(w);
  }
  return windows;
}

test("review 5 property: 40 keyword, operator and value combinations never leak through either function", () => {
  const combos = generateCombos();
  expect(combos.length).toBe(40);
  for (const { line, value } of combos) {
    const windows = fourCharWindows(value);
    expect(windows.length).toBeGreaterThan(0);
    const redacted = redactSecrets(line);
    const shown = lastMeaningfulLine(`${CLEAN}\n${line}`);
    const embedded = lastMeaningfulLine(`${CLEAN}\nrun ${line}\ndone`);
    for (const w of windows) {
      expect(redacted).not.toContain(w);
      expect(shown).not.toContain(w);
      expect(embedded).not.toContain(w);
    }
    expect(shown === "" || shown === CLEAN).toBe(true);
  }
});

test("review 5 non-blocking: a secret wrapped over three narrow rows with a letters only tail is dropped", () => {
  const rows = ["abcdefghij0123456789", "klmnopqr", "stuvwxyz"];
  const out = lastMeaningfulLine(rows.join("\n"));
  expect(out).toBe("");
  for (const row of rows) expect(out).not.toContain(row.slice(0, 4));
  expect(lastMeaningfulLine(`${CLEAN}\n${rows.join("\n")}`)).toBe(CLEAN);
  expect(lastMeaningfulLine(`${CLEAN}\n│ ${rows[0]} │\n│ ${rows[1]} │\n│ ${rows[2]} │`)).toBe(CLEAN);
});

test("review 5 non-blocking: a secret wrapped over four narrow rows leaks no row", () => {
  const rows = ["Zq81mXk3Vb", "pLw92Hs0Tn", "qrstuvwx", "yzabcdef"];
  const out = lastMeaningfulLine(`${CLEAN}\n${rows.join("\n")}`);
  expect(out).toBe(CLEAN);
});

test("review 5 non-blocking: short unrelated token rows are still shown", () => {
  expect(lastMeaningfulLine("src\nlib\ntests")).toBe("tests");
  expect(lastMeaningfulLine(`${CLEAN}\nnode_modules\nsrc\npackage`)).toBe("package");
});
