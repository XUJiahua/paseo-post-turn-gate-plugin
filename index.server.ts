import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGate, type Paseo } from "./server/gate.ts";
import { Ledger, defaultLedgerPath } from "./server/ledger.ts";

const RECONCILE_INTERVAL_MS = 60_000;

export default function contribute(server: PluginServerContext) {
  const ledger = new Ledger(defaultLedgerPath());
  const gate = createGate({ ledger });
  let timer: ReturnType<typeof setInterval> | null = null;

  // The server context has no SDK handle; the first hook supplies it, which also triggers recovery.
  // ponytail: nothing is recovered until some agent event arrives after a restart.
  function capture(paseo: Paseo): Paseo {
    if (!timer) {
      gate.reconcile(paseo);
      timer = setInterval(() => gate.reconcile(paseo), RECONCILE_INTERVAL_MS);
    }
    return paseo;
  }

  // Handlers only enqueue and return, keeping every hook far below the 30s hook timeout.
  server.on("agent.turn_started", (event, { paseo }) => gate.onTurnStarted(event, capture(paseo)));
  server.on("agent.turn_ended", (event, { paseo }) => gate.onTurnEnded(event, capture(paseo)));
  server.on("agent.permission_requested", (event, { paseo }) => gate.onPermission(event, capture(paseo), true));
  server.on("agent.permission_resolved", (event, { paseo }) => gate.onPermission(event, capture(paseo), false));

  return async () => {
    if (timer) clearInterval(timer);
    await gate.idle();
    ledger.close();
  };
}
