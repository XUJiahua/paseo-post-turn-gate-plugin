import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Ledger, defaultLedgerPath } from "./server/ledger.ts";
import { createSupervisor } from "./server/supervisor.ts";
import { startRecoveryConnection } from "./server/startup.ts";
import { stopAnsweringRpc } from "./shared/schema.ts";

export default function contribute(server: PluginServerContext) {
  const ledger = new Ledger(defaultLedgerPath());
  const supervisor = createSupervisor({ ledger });
  let recovery: ReturnType<typeof startRecoveryConnection> | null = null;
  if (process.env.POST_TURN_GATE_RECOVERY_URL) {
    try {
      recovery = startRecoveryConnection({
        url: process.env.POST_TURN_GATE_RECOVERY_URL,
        password: process.env.POST_TURN_GATE_RECOVERY_PASSWORD,
        supervisor,
        log: (message) => console.log(`[post-turn-gate] ${message}`),
      });
    } catch (error) {
      console.error(`[post-turn-gate] Startup recovery disabled: ${error instanceof Error ? error.message : "invalid configuration"}`);
    }
  }

  server.on("agent.turn_started", (event, { paseo }) => supervisor.accept({ type: "turn_started", event }, paseo));
  server.on("agent.turn_ended", (event, { paseo }) => supervisor.accept({ type: "turn_ended", event }, paseo));
  server.on("agent.permission_requested", (event, { paseo }) => supervisor.accept({ type: "permission_requested", event }, paseo));
  server.on("agent.permission_resolved", (event, { paseo }) => supervisor.accept({ type: "permission_resolved", event }, paseo));

  server.handle(stopAnsweringRpc, async ({ chainId, resume }, { paseo }) => ({
    stopped: await supervisor.control({ taskId: chainId, action: resume ? "resume_answering" : "stop_answering" }, paseo),
  }));

  return async () => {
    await supervisor.close();
    await recovery?.close();
    ledger.close();
  };
}
