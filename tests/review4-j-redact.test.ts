import { expect, test } from "bun:test";
import { lastMeaningfulLine, redactSecrets } from "../src/herdr/pane-text.ts";

const AWS_HEAD = "AKIA" + "ABCDEFGH";
const AWS_TAIL = "IJKLMNOP";
const HEX = "9f86d081884c7d659a2f" + "eaa0c55ad015a3bf4f1b" + "2b0b822cd15d6c15b0f0";

test("round 4 finding 1: a wrapped token is dropped even when the line already holds a redaction", () => {
  const out = lastMeaningfulLine(`password=x ${AWS_HEAD}\n${AWS_TAIL} done`);
  expect(out).not.toContain(AWS_HEAD);
  expect(out).not.toContain("AKIA");
  expect(out).not.toContain(AWS_TAIL);
});

test("round 4 finding 1: a hex prefix wrapped after a redacted token is dropped", () => {
  const head = HEX.slice(0, 26);
  const out = lastMeaningfulLine(`● Bash(curl -H token=abc https://h/${head}\n${HEX.slice(26)})`);
  expect(out).not.toContain(head);
  expect(out).not.toContain(HEX.slice(26));
});

test("round 4 finding 1: a line holding a secret is dropped instead of shown redacted", () => {
  expect(lastMeaningfulLine("token: abcd1234efgh\nall_done")).toBe("");
  expect(lastMeaningfulLine("password=x\nall done")).toBe("done");
});

test("round 4 finding 2: a key=value secret wrapped over three lines does not leak its tail", () => {
  const first = "password=Zx!aaaa@bbbb#cc";
  const middle = "dd$eeee%ffff^gggg&hh";
  const last = "ii*jjjj";
  const out = lastMeaningfulLine(`${first}\n${middle}\n${last} tail text`);
  expect(out).not.toContain(last);
  expect(out).not.toContain(middle);
  expect(out).not.toContain("Zx!");
  expect(lastMeaningfulLine(`${first}\n${middle}\n${last}`)).toBe("");
});

test("round 4 finding 2: a secret wrapped over four lines does not leak its tail", () => {
  const out = lastMeaningfulLine("password=Zx!aaaa@bbbb#cc\ndd$eeee%ffff^gggg&hh\nii*jjjj%kkkk!llll#mm\nnn@oooo$pppp tail text");
  expect(out).not.toContain("nn@oooo");
  expect(out).not.toContain("ii*jjjj");
  expect(out).not.toContain("dd$eeee");
});

test("round 4 finding 2: a plain word after a wrapped value is still shown", () => {
  expect(lastMeaningfulLine("password:\np4ssw0rdv4lue9\nlater")).toBe("later");
});

test("round 4 finding 8: a password containing an unescaped @ is redacted up to the host", () => {
  const out = redactSecrets("https://user:pa@ss@h/x");
  expect(out).toBe("https://user:[REDACTED]@h/x");
  expect(out).not.toContain("ss@");
  expect(redactSecrets("user:pa@ss@h/x")).toBe("user:[REDACTED]@h/x");
  expect(redactSecrets("postgres://admin:s3cr@t!x@db.internal:5432/app")).toBe("postgres://admin:[REDACTED]@db.internal:5432/app");
});

test("round 4 finding 8: plain URLs and host:port URLs are left alone", () => {
  expect(redactSecrets("http://localhost:3000/a")).toBe("http://localhost:3000/a");
  expect(redactSecrets("see https://example.com/docs")).toBe("see https://example.com/docs");
});
