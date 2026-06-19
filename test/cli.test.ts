import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const built = existsSync(CLI);

function run(input: string, args: string[] = []): { stdout: string; status: number } {
  try {
    // Pipe stderr (don't inherit) so the CLI's error output for the
    // expected-failure cases doesn't leak into the test runner's console.
    const stdout = execFileSync("node", [CLI, ...args], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

// These exercise the built bin; skip when dist isn't present (run `npm run build`).
describe.skipIf(!built)("cli", () => {
  it("repairs JSON piped on stdin", () => {
    const { stdout, status } = run('```json\n{name:"Ada",age:36,}\n```');
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('{"name":"Ada","age":36}');
  });

  it("pretty-prints with --pretty", () => {
    const { stdout } = run("{a:1}", ["--pretty"]);
    expect(stdout).toContain('\n  "a": 1');
  });

  it("serializes bigint output as a string with --bigint", () => {
    const { stdout } = run('{"id": 12345678901234567890}', ["--bigint"]);
    expect(stdout.trim()).toBe('{"id":"12345678901234567890"}');
  });

  it("exits 1 on empty input", () => {
    const { status } = run("   ");
    expect(status).toBe(1);
  });

  it("prints version with --version", () => {
    const { stdout } = run("", ["--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
