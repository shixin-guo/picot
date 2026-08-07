#!/usr/bin/env node
// ABOUTME: Verifies bundled Pi discovers configured Claude-style skills roots.
// ABOUTME: Runs isolated global/project RPC fixtures including project exclusion semantics.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function runScenario(binary, scenario) {
  const temp = await mkdtemp(join(tmpdir(), "picot-skills-smoke-"));
  const home = join(temp, "home");
  const cwd = join(temp, "workspace");
  const agentDir = join(home, ".pi", "agent");
  const settingsDir = scenario.scope === "global" ? agentDir : join(cwd, ".pi");
  const skillsRoot = join(scenario.scope === "global" ? home : cwd, ".claude", "skills");
  const skillNames = scenario.skillNames ?? [scenario.skill];

  await mkdir(cwd, { recursive: true });
  await mkdir(settingsDir, { recursive: true });
  for (const skill of skillNames) {
    const skillDir = join(skillsRoot, skill);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skill}\ndescription: smoke skill\n---\ninstructions\n`,
    );
  }
  await writeFile(
    join(settingsDir, "settings.json"),
    `${JSON.stringify({
      skills: scenario.rules ?? [
        scenario.scope === "global" ? "../../.claude/skills" : "../.claude/skills",
      ],
    })}\n`,
  );

  const sub = Bun.spawn([binary, "--mode", "rpc", "--no-session", "--approve"], {
    env: { ...process.env, HOME: home, PI_AGENT_ROOT: agentDir },
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = (async () => {
    try {
      for await (const chunk of sub.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          const waiter = pending.get(frame.id);
          if (waiter) {
            pending.delete(frame.id);
            waiter.resolve(frame);
          }
        }
      }
    } catch {
      // Process shutdown is expected after the assertion.
    }
  })();

  function request(type) {
    const id = `skills-smoke-${nextId++}`;
    sub.stdin.write(`${JSON.stringify({ id, type })}\n`);
    return new Promise((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectFrame(new Error(`timeout waiting for ${type}`));
      }, 15_000);
      pending.set(id, {
        resolve(frame) {
          clearTimeout(timeout);
          resolveFrame(frame);
        },
      });
    });
  }

  try {
    const response = await request("get_commands");
    if (response.type !== "response" || response.success !== true) {
      throw new Error(`unexpected response: ${JSON.stringify(response)}`);
    }
    const commands = response.data?.commands ?? [];
    const skillCommands = new Set(
      commands.filter((command) => command.source === "skill").map((command) => command.name),
    );
    for (const skill of scenario.present ?? [scenario.skill]) {
      const expected = `skill:${skill}`;
      if (!skillCommands.has(expected)) {
        throw new Error(`missing ${expected}; got ${commands.length} commands`);
      }
    }
    for (const skill of scenario.absent ?? []) {
      const forbidden = `skill:${skill}`;
      if (skillCommands.has(forbidden)) throw new Error(`unexpected ${forbidden}`);
    }
    console.log(`[smoke] OK: ${scenario.name}`);
  } finally {
    sub.kill();
    await reader;
    await rm(temp, { recursive: true, force: true });
  }
}

async function main() {
  let version;
  try {
    version = JSON.parse(await readFile(join(root, "scripts", "pi-version.json"), "utf8")).version;
  } catch (error) {
    throw new Error(`failed to read Pi version: ${error instanceof Error ? error.message : error}`);
  }
  const binary = join(
    root,
    "src-tauri",
    "resources",
    "pi",
    process.platform === "win32" ? "pi.exe" : "pi",
  );
  await runScenario(binary, {
    name: "global exposes skill:review",
    scope: "global",
    skill: "review",
  });
  await runScenario(binary, {
    name: "project exposes skill:summarize",
    scope: "project",
    skill: "summarize",
  });
  await runScenario(binary, {
    name: "project rule excludes review while retaining summarize",
    scope: "project",
    skillNames: ["review", "summarize"],
    rules: ["../.claude/skills", "!../.claude/skills/review/**"],
    present: ["summarize"],
    absent: ["review"],
  });
  console.log(`[smoke] all isolated skill paths verified against Pi ${version}`);
}

main().catch((error) => {
  console.error(`[smoke] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
