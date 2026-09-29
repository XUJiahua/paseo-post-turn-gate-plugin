import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { CardData, RunStatus } from "../shared/schema.ts";

const LABELS: Record<RunStatus, string> = {
  DISPATCHING: "Starting",
  REVIEWING: "Running",
  FIXING: "Fixing",
  PASSED: "PASS",
  INCONCLUSIVE: "INCONCLUSIVE",
  FAILED: "FAIL",
  NEEDS_HUMAN: "NEEDS HUMAN",
  ERROR: "ERROR",
  SUPERSEDED: "Superseded",
};

export function GateCard({ item, theme }: PluginTimelineItemProps<CardData>) {
  const data = item.data;
  const styles = useMemo(
    () => ({
      card: {
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 12,
        backgroundColor: theme.colors.surface1,
      },
      header: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 8 },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted },
      body: { color: theme.colors.foreground },
      success: { color: theme.colors.statusSuccess, fontWeight: "600" as const },
      warning: { color: theme.colors.statusWarning, fontWeight: "600" as const },
      danger: { color: theme.colors.statusDanger, fontWeight: "600" as const },
      running: { color: theme.colors.accent, fontWeight: "600" as const },
      finding: { gap: 2, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: theme.colors.statusDanger },
    }),
    [theme],
  );

  let statusStyle = styles.running;
  if (data.status === "PASSED") statusStyle = styles.success;
  if (data.status === "INCONCLUSIVE" || data.status === "SUPERSEDED") statusStyle = styles.warning;
  if (data.status === "FAILED" || data.status === "ERROR" || data.status === "NEEDS_HUMAN") statusStyle = styles.danger;

  const role = data.action === "verify" ? "Verify" : data.action === "review" ? "Review" : "Gate";
  const rounds = data.maxFixRounds > 0 ? ` · round ${data.round}/${data.maxFixRounds + 1}` : "";
  const status = data.waiting ? "Waiting for permission" : LABELS[data.status];

  return (
    <View style={styles.card} accessible accessibilityLabel={`Post-turn gate ${role}: ${status}`}>
      <View style={styles.header}>
        <Text style={styles.title}>
          Post-turn gate · {role}
          {rounds}
        </Text>
        <Text style={data.waiting ? styles.warning : statusStyle}>{status}</Text>
      </View>
      {data.summary ? <Text style={styles.body}>{data.summary}</Text> : null}
      {data.findings.map((finding, index) => (
        <View key={`${index}-${finding.title}`} style={styles.finding}>
          <Text style={styles.body}>
            [{finding.severity}] {finding.title}
          </Text>
          <Text style={styles.muted}>{finding.evidence}</Text>
          <Text style={styles.muted}>Fix: {finding.suggested_fix}</Text>
        </View>
      ))}
      {data.otherFindings > 0 ? (
        <Text style={styles.muted}>+{data.otherFindings} non-blocking finding(s)</Text>
      ) : null}
      {data.reviewerChanges ? (
        <Text style={styles.warning} selectable>
          Reviewer modified the workspace:{"\n"}
          {data.reviewerChanges}
        </Text>
      ) : null}
      {data.error ? (
        <Text style={styles.danger} selectable>
          {data.error}
        </Text>
      ) : null}
      {data.childAgentId ? (
        <Text style={styles.muted} selectable>
          {data.childTitle ?? "Reviewer"} · {data.childAgentId} (open it from History)
        </Text>
      ) : null}
    </View>
  );
}
