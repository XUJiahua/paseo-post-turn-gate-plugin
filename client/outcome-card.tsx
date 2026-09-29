import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Category, OutcomeCard as OutcomeCardData } from "../shared/schema.ts";
import { stopAnsweringRpc } from "../shared/schema.ts";
import { PermissionPrompt, cardStyles } from "./gate-card.tsx";

const CATEGORY_LABELS: Record<Category, string> = {
  done: "Finished",
  awaiting_user: "Waiting for an answer",
  refused: "Agent declined",
  user_canceled: "Stopped",
  replaced: "Replaced",
  crashed: "Agent process exited",
  network: "Network error",
  rate_limited: "Rate limited",
  quota_exhausted: "Quota used up",
  context_exhausted: "Context used up",
  error: "Turn failed",
};

function stateLabel(data: OutcomeCardData): string {
  switch (data.state) {
    case "answering":
      return "Answering for you…";
    case "answered":
      return `Answered for you (${data.attempt}/${data.maxAttempts})`;
    case "needs_user":
      return "Needs you";
    case "retry_scheduled":
      return `Retry ${data.attempt}/${data.maxAttempts} scheduled`;
    case "retrying":
      return `Retrying (${data.attempt}/${data.maxAttempts})`;
    case "stopped":
      return "Stopped";
    case "resolved":
      return "Resolved";
    default:
      return CATEGORY_LABELS[data.category];
  }
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export function OutcomeCard({ item, theme }: PluginTimelineItemProps<OutcomeCardData>) {
  const data = item.data;
  const styles = useMemo(() => cardStyles(theme), [theme]);
  const stop = useRpc(stopAnsweringRpc);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let statusStyle = styles.warning;
  if (data.state === "resolved" || data.state === "answered") statusStyle = styles.success;
  if (data.state === "answering" || data.state === "retrying" || data.state === "retry_scheduled") statusStyle = styles.running;
  if (data.state === "needs_user" || (data.state === "notice" && data.category !== "done")) statusStyle = styles.danger;

  async function onStop() {
    setStopping(true);
    setError(null);
    try {
      await stop({ chainId: data.chainId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStopping(false);
    }
  }

  const status = stateLabel(data);
  return (
    <View style={styles.card} accessible accessibilityLabel={`Post-turn gate: ${CATEGORY_LABELS[data.category]}, ${status}`}>
      <View style={styles.header}>
        <Text style={styles.title}>Post-turn gate · {CATEGORY_LABELS[data.category]}</Text>
        <Text style={statusStyle}>{status}</Text>
      </View>
      {data.permission ? <PermissionPrompt permission={data.permission} styles={styles} who="Answerer" /> : null}
      {data.question ? (
        <Text style={styles.body} selectable>
          Agent asked: {data.question}
        </Text>
      ) : null}
      {data.answer ? (
        <Text style={styles.body} selectable>
          Answer sent: {data.answer}
        </Text>
      ) : null}
      {data.message ? (
        <Text style={data.state === "needs_user" ? styles.danger : styles.muted} selectable>
          {data.message}
        </Text>
      ) : null}
      {data.suggestion ? <Text style={styles.muted}>{data.suggestion}</Text> : null}
      {data.nextRetryAt ? <Text style={styles.muted}>Next retry at {formatTime(data.nextRetryAt)}</Text> : null}
      {data.canStopAnswering ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop auto-answering for this task"
            accessibilityState={{ disabled: stopping }}
            disabled={stopping}
            style={styles.deny}
            onPress={() => void onStop()}
          >
            <Text style={styles.denyText}>Stop auto-answering</Text>
          </Pressable>
        </View>
      ) : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {data.childAgentId ? (
        <Text style={styles.muted} selectable>
          Answerer · {data.childAgentId} (open it from History)
        </Text>
      ) : null}
    </View>
  );
}
