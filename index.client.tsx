import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GateCard } from "./client/gate-card.tsx";
import { CARD_KIND, CARD_VERSION, cardSchema } from "./shared/schema.ts";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({ kind: CARD_KIND, version: CARD_VERSION, schema: cardSchema, Component: GateCard });
  return () => {};
}
