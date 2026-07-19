import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const binary = join(
  root,
  "src-tauri",
  "resources",
  "pi",
  process.platform === "win32" ? "pi.exe" : "pi",
);
const fixtureDir = join(root, "tests", "fixtures", "pi-rpc", "0.80.10");
const update = process.argv.includes("--update");
const temp = await mkdtemp(join(tmpdir(), "picot-rpc-smoke-"));
const extension = join(temp, "smoke-extension.ts");

await writeFile(
  extension,
  `export default function (pi) {
    pi.registerCommand("picot-smoke", {
      description: "Picot RPC contract smoke command",
      handler: async (_args, ctx) => ctx.ui.notify("picot smoke accepted", "info"),
    });
  }\n`,
);

const subprocess = Bun.spawn([binary, "--mode", "rpc", "--no-session", "--extension", extension], {
  cwd: temp,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const pending = new Map();
const observedEvents = [];
let stdoutBuffer = "";
let nextId = 1;

const reader = (async () => {
  for await (const chunk of subprocess.stdout) {
    stdoutBuffer += new TextDecoder().decode(chunk, { stream: true });
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      const waiter = frame.id && pending.get(frame.id);
      if (waiter && frame.type === "response") {
        pending.delete(frame.id);
        waiter.resolve(frame);
      } else {
        observedEvents.push(frame);
      }
    }
  }
})();

function request(command, timeoutMs = 5_000) {
  const id = `smoke-${nextId++}`;
  const frame = { id, ...command };
  subprocess.stdin.write(`${JSON.stringify(frame)}\n`);
  return new Promise((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`Timed out waiting for ${command.type}`));
    }, timeoutMs);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timeout);
        resolveRequest(value);
      },
    });
  });
}

function assertSuccess(frame, command) {
  if (frame.type !== "response" || frame.command !== command || frame.success !== true) {
    throw new Error(`Unexpected ${command} response: ${JSON.stringify(frame)}`);
  }
}

try {
  const state = await request({ type: "get_state" });
  const commands = await request({ type: "get_commands" });
  const steering = await request({ type: "set_steering_mode", mode: "all" });
  const followUp = await request({ type: "set_follow_up_mode", mode: "one-at-a-time" });
  const prompt = await request({ type: "prompt", message: "/picot-smoke" });
  const abort = await request({ type: "abort" });
  for (const [name, frame] of Object.entries({
    get_state: state,
    get_commands: commands,
    set_steering_mode: steering,
    set_follow_up_mode: followUp,
    prompt,
    abort,
  })) {
    assertSuccess(frame, name);
  }

  const contract = {
    version: "0.80.10",
    commands: [
      "get_state",
      "get_commands",
      "set_steering_mode",
      "set_follow_up_mode",
      "prompt",
      "abort",
    ],
    stateFields: Object.keys(state.data ?? {}).sort(),
    commandSources: [...new Set((commands.data?.commands ?? []).map((item) => item.source))].sort(),
    eventTypes: [...new Set(observedEvents.map((event) => event.type))].sort(),
    promptAcceptance: prompt.success,
  };
  const fixture = join(fixtureDir, "contract.json");
  if (update) {
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(fixture, `${JSON.stringify(contract, null, 2)}\n`);
  } else {
    const expected = await Bun.file(fixture).json();
    if (JSON.stringify(contract) !== JSON.stringify(expected)) {
      throw new Error(
        `Pi RPC contract drifted. Run bun run smoke:pi-rpc --update after review.\n${JSON.stringify(contract, null, 2)}`,
      );
    }
  }
  console.log(`Pi ${contract.version} RPC smoke passed (${contract.commands.length} commands)`);
} finally {
  subprocess.stdin.end();
  await subprocess.exited;
  await reader;
  await rm(temp, { recursive: true, force: true });
}
