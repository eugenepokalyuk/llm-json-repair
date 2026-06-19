#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { repairJson } from "./repair.js";
import { JsonRepairError } from "./types.js";

const HELP = `llm-json-repair — repair broken JSON from LLM output

Usage:
  llm-json-repair [file] [options]
  cat broken.json | llm-json-repair

Options:
  -p, --pretty       Pretty-print the output (2-space indent)
      --bigint       Parse precision-losing integers as bigint
  -q, --quiet        Exit non-zero on failure but print nothing to stderr
  -h, --help         Show this help
  -v, --version      Print the version

Reads JSON from <file> or stdin, repairs it, and writes canonical JSON to
stdout. Exits 1 if nothing parseable is found.
`;

interface Cli {
  file?: string;
  pretty: boolean;
  bigint: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Cli | "help" | "version" {
  const cli: Cli = { pretty: false, bigint: false, quiet: false };
  for (const arg of argv) {
    switch (arg) {
      case "-h":
      case "--help":
        return "help";
      case "-v":
      case "--version":
        return "version";
      case "-p":
      case "--pretty":
        cli.pretty = true;
        break;
      case "--bigint":
        cli.bigint = true;
        break;
      case "-q":
      case "--quiet":
        cli.quiet = true;
        break;
      default:
        if (arg.startsWith("-")) {
          process.stderr.write(`Unknown option: ${arg}\n`);
          process.exit(2);
        }
        cli.file = arg;
    }
  }
  return cli;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (parsed === "version") {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  const input = parsed.file ? readFileSync(parsed.file, "utf8") : readStdin();
  const result = repairJson(input, { bigint: parsed.bigint });

  if (!result.ok) {
    if (!parsed.quiet) {
      process.stderr.write(`error: ${result.error.message}\n`);
    }
    process.exit(1);
  }

  const replacer = (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value;
  const json = JSON.stringify(result.value, replacer, parsed.pretty ? 2 : undefined);
  process.stdout.write(`${json}\n`);
}

try {
  main();
} catch (err) {
  const message =
    err instanceof JsonRepairError || err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
