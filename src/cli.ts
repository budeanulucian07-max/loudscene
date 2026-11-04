#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { run, type Io } from "./commands.js";

/**
 * Entry point of the `loudscene` binary: wires the real process (stdio, env, fetch, clock,
 * browser, terminal prompt) into the command runner in commands.ts.
 */

function version(): string {
  try {
    // ../package.json from both src/ (tsx, tests) and dist/ (published).
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function openUrl(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** One line from the terminal; with `hidden`, typed characters are not echoed (API keys). */
function prompt(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
    if (hidden && process.stdin.isTTY) {
      // readline echoes through _writeToOutput; printing only the prompt keeps the key off screen.
      const r = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      r._writeToOutput = (s: string) => {
        if (s.startsWith(question)) r.output.write(question);
        else if (s.includes("\n") || s.includes("\r")) r.output.write("\n");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const io: Io = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  interactive: process.stderr.isTTY === true,
  version: version(),
  openUrl,
  prompt,
};

process.exitCode = await run(process.argv.slice(2), io);
