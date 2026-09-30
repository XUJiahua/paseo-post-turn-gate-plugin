import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Category, OutcomeCard as OutcomeCardData } from "../shared/schema.ts";
import { stopAnsweringRpc } from "../shared/schema.ts";
import { LogsCommand, PermissionPrompt, cardStyles } from "./gate-card.tsx";

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
  if (data.decider) {
    switch (data.state) {
      case "answer_scheduled":
        return "Deciding soon";
      case "answering":
        return data.childAgentId ? "Deciding…" : "Checking…";
      case "answered":
        return `Replied for you (${data.attempt}/${data.maxAttempts})`;
      case "resolved":
        return data.category === "done" ? "Completed" : "Resolved";
    }
  }
  switch (data.state) {
    case "answer_scheduled":
      return "Answering for you soon";
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
  if (data.state === "answer_scheduled" || data.state === "answering" || data.state === "retrying" || data.state === "retry_scheduled") {
    statusStyle = styles.running;
  }
  if (data.state === "needs_user" || (data.state === "notice" && data.category !== "done")) statusStyle = styles.danger;

  async function onStop(resume = false) {
    setStopping(true);
    setError(null);
    try {
      await stop({ chainId: data.chainId, ...(resume ? { resume: true } : {}) });
      setStopping(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStopping(false);
    }
  }

  const status = stateLabel(data);
  const title = data.decider ? "Post-turn supervisor" : `Post-turn gate · ${CATEGORY_LABELS[data.category]}`;
  const who = data.decider ? "Decider" : "Answerer";
  return (
    <View style={styles.card} accessible accessibilityLabel={`${title}, ${status}`}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={statusStyle}>{status}</Text>
      </View>
      {data.permission ? <PermissionPrompt permission={data.permission} styles={styles} who={data.decider && data.permission.agentId !== data.childAgentId ? "Checker" : who} /> : null}
      {data.question ? (
        <Text style={styles.body} selectable>
          Agent asked: {data.question}
        </Text>
      ) : null}
      {data.answer ? (
        <Text style={styles.body} selectable>
          {data.decider ? "Reply sent" : "Answer sent"}: {data.answer}
        </Text>
      ) : null}
      {data.checks ? (
        <Text style={styles.muted} selectable>
          {data.checks}
        </Text>
      ) : null}
      {data.message ? (
        <Text style={data.state === "needs_user" ? styles.danger : styles.muted} selectable>
          {data.message}
        </Text>
      ) : null}
      {data.suggestion ? <Text style={styles.muted}>{data.suggestion}</Text> : null}
      {data.nextRetryAt ? (
        <Text style={styles.muted}>
          {data.state === "answer_scheduled"
            ? `The ${who.toLowerCase()} starts at ${formatTime(data.nextRetryAt)} unless you reply first`
            : `Next retry at ${formatTime(data.nextRetryAt)}`}
        </Text>
      ) : null}
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
      {data.canResume ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Resume auto-answering for this task"
            accessibilityState={{ disabled: stopping }}
            disabled={stopping}
            style={styles.allow}
            onPress={() => void onStop(true)}
          >
            <Text style={styles.allowText}>Resume auto-answering</Text>
          </Pressable>
        </View>
      ) : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {data.childAgentId ? (
        <Text style={styles.muted} selectable>
          {who} · {data.childAgentId}
          {data.state === "answering" ? " (in this agent's Subagents)" : " (open it from History)"}
        </Text>
      ) : null}
      {data.childAgentId ? (
        <LogsCommand agentId={data.childAgentId} follow={data.state === "answering"} styles={styles} />
      ) : null}
    </View>
  );
}
