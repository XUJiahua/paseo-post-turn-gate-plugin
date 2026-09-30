import type { PluginHookContext } from "@getpaseo/plugin/server";

type Paseo = PluginHookContext["paseo"];

export type DispatchResult = "sent" | "busy" | "gone";

/**
 * The one path every automatic message to a source agent takes (fix, answer, retry; docs/completion-supervisor.md
 * §11.2). Paseo has no atomic "send only if idle" and send() cancels a running turn (design.md V5), so this is
 * best-effort: refresh, check the status, record the send, then send, with nothing awaited between the refresh
 * and send(). A user message in that window is canceled by ours.
 * ponytail: best-effort only; upgrade path is a host `sendIfIdle` used here, callers unchanged.
 *
 * `beforeSend` must be synchronous (ledger writes): an await there would widen the race.
 */
export async function sendIfIdle(
  paseo: Paseo,
  agentId: string,
  message: { text: string; messageId: string },
  options: { accept: readonly string[]; beforeSend?: () => void },
): Promise<DispatchResult> {
  const ref = paseo.agents.ref(agentId);
  const agent = (await ref.refresh())?.agent;
  if (!agent) return "gone";
  if (!options.accept.includes(agent.status)) return "busy";
  options.beforeSend?.();
  await ref.send(message.text, { messageId: message.messageId });
  return "sent";
}

/** Statuses a message may be sent in: a fix needs a finished turn; an answer or retry may follow a failed one. */
export const IDLE: readonly string[] = ["idle"];
export const IDLE_OR_ERROR: readonly string[] = ["idle", "error"];
