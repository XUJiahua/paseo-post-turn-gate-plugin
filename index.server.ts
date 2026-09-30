import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Ledger, defaultLedgerPath } from "./server/ledger.ts";
import { createSupervisor } from "./server/supervisor.ts";
import { stopAnsweringRpc } from "./shared/schema.ts";

export default function contribute(server: PluginServerContext) {
  const ledger = new Ledger(defaultLedgerPath());
  const supervisor = createSupervisor({ ledger });

  server.on("agent.turn_started", (event, { paseo }) => supervisor.accept({ type: "turn_started", event }, paseo));
  server.on("agent.turn_ended", (event, { paseo }) => supervisor.accept({ type: "turn_ended", event }, paseo));
  server.on("agent.permission_requested", (event, { paseo }) => supervisor.accept({ type: "permission_requested", event }, paseo));
  server.on("agent.permission_resolved", (event, { paseo }) => supervisor.accept({ type: "permission_resolved", event }, paseo));

  server.handle(stopAnsweringRpc, async ({ chainId }, { paseo }) => ({
    stopped: await supervisor.control({ taskId: chainId, action: "stop_answering" }, paseo),
  }));

  return async () => {
    await supervisor.close();
    ledger.close();
  };
}
