#!/usr/bin/env bun
// RoamBrain CLI entrypoint. Subcommands land in src/commands/.

const [, , cmd, ...args] = process.argv;

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log("roambrain <command> [args]");
  console.log("commands: (none yet — see plan.org)");
  process.exit(0);
}

console.error(`roambrain: unknown command '${cmd}'`);
process.exit(1);
