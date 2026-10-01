// Real Paseo host smoke, no model credentials or provider turns required.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const cli = process.argv[2] ?? "paseo";
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = await mkdtemp(path.join(tmpdir(), "ptg-host-smoke-"));
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const env = {
  ...process.env, PASEO_HOME: home,
  POST_TURN_GATE_RECOVERY_URL: `ws://127.0.0.1:${port}/ws`,
  PASEO_DICTATION_ENABLED: "false", PASEO_VOICE_MODE_ENABLED: "false",
  PASEO_RELAY_ENABLED: "false",
};
delete env.POST_TURN_GATE_RECOVERY_PASSWORD;
await writeFile(path.join(home, "config.json"), JSON.stringify({
  version: 1, pluginsEnabled: true, daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } },
}));
const daemon = spawn(cli, ["daemon", "run", "--home", home], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
daemon.stdout.on("data", (chunk) => { output = (output + chunk).slice(-100_000); });
daemon.stderr.on("data", (chunk) => { output = (output + chunk).slice(-100_000); });
let startupError;
daemon.on("error", (error) => { startupError = error; });
const run = (args) => execute(cli, [...args, "--home", home, "--json"], { env, timeout: 20_000, maxBuffer: 1_000_000 });
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (startupError) throw startupError;
    try {
      const result = JSON.parse((await run(["daemon", "status"])).stdout);
      if (result.connectedDaemon === "running" || result.connectedDaemon === "reachable") { ready = true; break; }
    } catch { /* host may not yet be listening */ }
    await delay(200);
  }
  assert.ok(ready, "isolated daemon did not become ready");
  await run(["plugin", "install", repo]);
  const list = JSON.parse((await run(["plugin", "ls", "post-turn-gate"])).stdout);
  assert.ok(JSON.stringify(list).includes('"running"'), "plugin did not load");
  let startupRecovered = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    const logs = (await run(["plugin", "logs", "post-turn-gate"])).stdout;
    if (logs.includes("Startup recovery connected; reconciliation started.")) { startupRecovered = true; break; }
    await delay(200);
  }
  assert.ok(startupRecovered, "plugin did not start recovery without agent hooks");
  const beforeReload = (await run(["plugin", "logs", "post-turn-gate"])).stdout;
  const recoveryCount = (logs) => logs.split("Startup recovery connected; reconciliation started.").length - 1;
  await run(["plugin", "reload", "post-turn-gate"]);
  let reloaded = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    const logs = (await run(["plugin", "logs", "post-turn-gate"])).stdout;
    if (recoveryCount(logs) > recoveryCount(beforeReload)) { reloaded = true; break; }
    await delay(200);
  }
  assert.ok(reloaded, "startup recovery did not reconnect after plugin reload");
  await run(["plugin", "disable", "post-turn-gate"]);
  const disabled = (await run(["plugin", "ls", "post-turn-gate"])).stdout;
  assert.ok(disabled.includes("disabled"));
  console.log("PASS: isolated Paseo daemon, plugin load, startup recovery without agent events, reload, disable.");
} catch (error) {
  // Print only the recent diagnostics on failure; never dump the environment.
  console.error(output.slice(-4_000));
  throw error;
} finally {
  await run(["daemon", "stop"]).catch(() => {});
  daemon.kill("SIGTERM");
  await new Promise((resolve) => {
    if (daemon.exitCode !== null) return resolve();
    daemon.once("exit", resolve);
    const timer = setTimeout(() => { daemon.kill("SIGKILL"); resolve(); }, 2_000);
    timer.unref();
  });
  await rm(home, { recursive: true, force: true });
}
