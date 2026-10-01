import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { createGate, type Paseo } from "./gate.ts";
import type { Ledger } from "./ledger.ts";

/**
 * The single entry point of the supervisor (docs/completion-supervisor.md §19). Hooks, RPCs and recovery all arrive as events;
 * callers never assemble the workflow. The gate owns decision rounds, checks and retries.
 */
export type SupervisorEvent =
  | { type: "turn_started"; event: PluginLifecycleEvents["agent.turn_started"] }
  | { type: "turn_ended"; event: PluginLifecycleEvents["agent.turn_ended"] }
  | { type: "permission_requested"; event: PluginLifecycleEvents["agent.permission_requested"] }
  | { type: "permission_resolved"; event: PluginLifecycleEvents["agent.permission_resolved"] }
  | { type: "reconcile" };

export type SupervisorControl = { taskId: string; action: "stop_answering" | "resume_answering" };

export interface CompletionSupervisor {
  /** Enqueues and returns at once, keeping every hook far below Paseo's 30s hook timeout. */
  accept(event: SupervisorEvent, paseo: Paseo): void;
  /** Card buttons. `taskId` identifies the current task chain. */
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
  let currentPaseo: Paseo | null = null;
  let closed = false;

  // The server context has no SDK handle (design.md V1). The optional startup client, or the first hook/RPC,
  // supplies it and starts recovery. Each later entry refreshes the handle used by the interval.
  function capture(paseo: Paseo): void {
    if (closed) return;
    currentPaseo = paseo;
    if (timer) return;
    gate.reconcile(paseo);
    timer = setInterval(() => { if (currentPaseo) gate.reconcile(currentPaseo); }, interval);
    timer.unref?.();
  }

  return {
    accept(event, paseo) {
      if (closed) return;
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
    control({ taskId, action }, paseo) {
      if (closed) return Promise.resolve(false);
      capture(paseo);
      return gate.stopAnswering(taskId, paseo, action === "resume_answering");
    },
    idle: () => gate.idle(),
    async close() {
      closed = true;
      currentPaseo = null;
      if (timer) clearInterval(timer);
      timer = null;
      gate.close();
      await gate.idle();
    },
  };
}
