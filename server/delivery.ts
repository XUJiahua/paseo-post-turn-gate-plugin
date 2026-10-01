import type { PluginHookContext } from "@getpaseo/plugin/server";

/** A bounded search is evidence of acceptance, never proof of non-delivery. */
export async function wasDelivered(
  paseo: PluginHookContext["paseo"], agentId: string, messageId: string, maxPages = 10,
): Promise<boolean> {
  const timeline = paseo.agents.ref(agentId).timeline;
  let cursor: { epoch: string; seq: number } | undefined;
  let epoch: string | undefined;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const page = await timeline.refetch({ direction: cursor ? "before" : "tail", cursor, limit: 500, projection: "canonical" });
    if (page.gap || (epoch && page.epoch !== epoch)) return false;
    epoch = page.epoch;
    if (page.entries.some(({ item }) => item.type === "user_message" &&
      (item.messageId === messageId || item.clientMessageId === messageId))) return true;
    const next = page.startCursor;
    if (!page.hasOlder || !next || (cursor && cursor.seq === next.seq && cursor.epoch === next.epoch)) return false;
    cursor = next;
  }
  return false;
}
