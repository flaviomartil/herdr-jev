#!/usr/bin/env bun
if (process.argv[2] === "rules") {
  const { main } = await import("../src/rules/cli.ts");
  process.exit(await main(process.argv.slice(3)));
}
await import("../src/cli.ts");
