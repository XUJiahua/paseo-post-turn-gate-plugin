import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { createGate, type Paseo } from "./gate.ts";
import type { Ledger } from "./ledger.ts";

/**
 * The single entry point of the supervisor (docs/completion-supervisor.md §19). Hooks, RPCs and recovery all arrive as events;
 * callers never assemble the workflow. The v2 gate runs behind it unchanged.
 */
export type SupervisorEvent =
  | { type: "turn_started"; event: PluginLifecycleEvents["agent.turn_started"] }
  | { type: "turn_ended"; event: PluginLifecycleEvents["agent.turn_ended"] }
  | { type: "permission_requested"; event: PluginLifecycleEvents["agent.permission_requested"] }
  | { type: "permission_resolved"; event: PluginLifecycleEvents["agent.permission_resolved"] }
  | { type: "reconcile" };

export type SupervisorControl = { taskId: string; action: "stop_answering" };

export interface CompletionSupervisor {
  /** Enqueues and returns at once, keeping every hook far below Paseo's 30s hook timeout. */
  accept(event: SupervisorEvent, paseo: Paseo): void;
  /** Card buttons. `taskId` is the v2 chain id until decision rounds replace chains. */
  control(control: SupervisorControl, paseo: Paseo): Promise<boolean>;
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface SupervisorOptions {
  ledger: Ledger;
  reconcileIntervalMs?: number;
  now?: () => number;
  minuteMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export function createSupervisor(options: SupervisorOptions): CompletionSupervisor {
  const gate = createGate(options);
  const interval = options.reconcileIntervalMs ?? 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  // The server context has no SDK handle (design.md V1); the first event supplies it and starts recovery.
  // ponytail: nothing is recovered until some agent event arrives after a restart; upgrade path is a ready hook.
  function capture(paseo: Paseo): void {
    if (timer) return;
    gate.reconcile(paseo);
    timer = setInterval(() => gate.reconcile(paseo), interval);
    timer.unref?.();
  }

  return {
    accept(event, paseo) {
      capture(paseo);
      switch (event.type) {
        case "turn_started":
          return gate.onTurnStarted(event.event, paseo);
        case "turn_ended":
          return gate.onTurnEnded(event.event, paseo);
        case "permission_requested":
        case "permission_resolved":
          return gate.onPermission(event.event, paseo);
        case "reconcile":
          return gate.reconcile(paseo);
      }
    },
    control({ taskId }, paseo) {
      capture(paseo);
      return gate.stopAnswering(taskId, paseo);
    },
    idle: () => gate.idle(),
    async close() {
      if (timer) clearInterval(timer);
      timer = null;
      gate.close();
      await gate.idle();
    },
  };
}
