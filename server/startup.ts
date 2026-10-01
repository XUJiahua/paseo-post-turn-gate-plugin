import { createPaseoClient, type PaseoClient, type PaseoClientConfig } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import type { CompletionSupervisor } from "./supervisor.ts";

/** Explicit local endpoint only: never guess a port or silently connect to a remote host. */
export function startRecoveryConnection(options: {
  url: string;
  password?: string;
  supervisor: CompletionSupervisor;
  createClient?: (config: PaseoClientConfig) => PaseoClient;
  retryMs?: number;
  log?: (message: string) => void;
}): { close(): Promise<void> } {
  const url = new URL(options.url);
  if (!["ws:", "wss:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Recovery URL must be an explicit loopback WebSocket endpoint without credentials or query parameters");
  }
  const client = (options.createClient ?? createPaseoClient)({
    url: url.toString(), password: options.password, appVersion: "0.10.1",
    clientId: `post-turn-gate-recovery-${randomUUID()}`, connectTimeoutMs: 5_000,
    reconnect: { enabled: false },
  });
  let closed = false;
  let connecting = false;
  let ready = false;
  async function tick(): Promise<void> {
    if (closed || connecting) return;
    connecting = true;
    try {
      if (client.getConnectionState().status !== "connected") {
        ready = false;
        await client.connect();
      }
      if (!closed && !ready) {
        options.supervisor.accept({ type: "reconcile" }, client);
        ready = true;
        options.log?.("Startup recovery connected; reconciliation started.");
      }
    } catch {
      // Do not log credentials or connection payloads. Existing hooks remain the fallback.
      options.log?.("Startup recovery could not connect; retrying. Lifecycle recovery remains available.");
    } finally {
      connecting = false;
    }
  }
  const timer = setInterval(() => void tick(), options.retryMs ?? 5_000);
  timer.unref?.();
  void tick();
  return { async close() { closed = true; clearInterval(timer); await client.close(); } };
}
