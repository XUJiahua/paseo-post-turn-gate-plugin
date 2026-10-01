import type { PluginHookContext } from "@getpaseo/plugin/server";

type Paseo = PluginHookContext["paseo"];

export type DispatchResult = "sent" | "busy" | "gone" | "stale" | "unknown";

/**
 * The one path every automatic message to a source agent takes (decision, retry; docs/completion-supervisor.md
 * §11.2). Paseo has no atomic "send only if idle" and send() cancels a running turn (design.md V5), so this is
 * best-effort: check the local revision, refresh, recheck revision/status/permissions, record intent, then send,
 * with nothing awaited between the last check and send(). Hooks received before that check invalidate queued
 * work. A user message not yet observed by the plugin can still be canceled by ours in the final host race.
 * ponytail: best-effort only; upgrade path is a host `sendIfIdle` used here, callers unchanged.
 *
 * Callbacks must be synchronous ledger writes. A failed acknowledgement means unknown acceptance, not a
 * safe retry: callers reconcile positive timeline evidence or pause for the user.
 */
export async function sendIfIdle(
  paseo: Paseo,
  agentId: string,
  message: { text: string; messageId: string },
  options: {
    accept: readonly string[];
    isCurrent?: () => boolean;
    beforeSend?: () => void;
    onAccepted?: () => void;
    onUnknown?: (error: unknown) => void;
  },
): Promise<DispatchResult> {
  if (options.isCurrent && !options.isCurrent()) return "stale";
  const ref = paseo.agents.ref(agentId);
  const agent = (await ref.refresh())?.agent;
  if (!agent) return "gone";
  if (options.isCurrent && !options.isCurrent()) return "stale";
  if (!options.accept.includes(agent.status)) return "busy";
  // Waiting on permissions is not a safe point to start a new automatic turn.
  if (agent.pendingPermissions?.length) return "busy";
  options.beforeSend?.();
  try {
    await ref.send(message.text, { messageId: message.messageId });
  } catch (error) {
    options.onUnknown?.(error);
    return "unknown";
  }
  options.onAccepted?.();
  return "sent";
}

/** A decision or retry may follow a finished or failed turn. */
export const IDLE_OR_ERROR: readonly string[] = ["idle", "error"];
