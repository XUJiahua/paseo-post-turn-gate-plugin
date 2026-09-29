import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GateCard } from "./client/gate-card.tsx";
import { OutcomeCard } from "./client/outcome-card.tsx";
import {
  CARD_KIND,
  CARD_VERSION,
  OUTCOME_CARD_KIND,
  OUTCOME_CARD_VERSION,
  cardSchema,
  outcomeCardSchema,
} from "./shared/schema.ts";

export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({ kind: CARD_KIND, version: CARD_VERSION, schema: cardSchema, Component: GateCard });
  client.addTimelineRenderer({
    kind: OUTCOME_CARD_KIND,
    version: OUTCOME_CARD_VERSION,
    schema: outcomeCardSchema,
    Component: OutcomeCard,
  });
  return () => {};
}
