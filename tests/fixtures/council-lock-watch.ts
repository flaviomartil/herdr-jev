import { readFileSync, writeFileSync } from "node:fs";

const [path, out, endAt] = process.argv.slice(2);
let bad = 0;
let seen = 0;
writeFileSync(out!, "started");
while (Date.now() < Number(endAt)) {
  let raw: string | undefined;
  try {
    raw = readFileSync(path!, "utf8");
  } catch {
    continue;
  }
  seen += 1;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") bad += 1;
  } catch {
    bad += 1;
  }
}
writeFileSync(out!, JSON.stringify({ bad, seen }));
