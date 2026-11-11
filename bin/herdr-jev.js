#!/usr/bin/env bun
if (process.argv[2] === "rules") {
  const { main } = await import("../src/rules/cli.ts");
  process.exit(await main(process.argv.slice(3)));
}
if (process.argv[2] === "worker-run" || process.argv[2] === "panes") {
  const { main } = await import("../src/panes/cli.ts");
  process.exit(await main(process.argv.slice(2)));
}
await import("../src/cli.ts");
