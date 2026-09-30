import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { copyText } from "@getpaseo/plugin/client/react-native";
import type { CardData, PermissionCard } from "../shared/schema.ts";

export function cardStyles(theme: PluginTimelineItemProps["theme"]) {
  return {
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
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
      allow: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: theme.colors.accent },
      allowText: { color: theme.colors.accentForeground },
      deny: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      denyText: { color: theme.colors.foreground },
      permission: { gap: 6, padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 },
      command: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        padding: 8,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      code: { flex: 1, color: theme.colors.foreground, fontFamily: "monospace" },
      finding: { gap: 2, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: theme.colors.statusDanger },
  };
}

export function GateCard({ item, theme }: PluginTimelineItemProps<CardData>) {
  const data = item.data;
  const styles = useMemo(() => cardStyles(theme), [theme]);

  return (
    <View style={styles.card} accessible accessibilityLabel={`Post-turn gate: ${data.fixed ? "Fixed" : "Error"}`}>
      <View style={styles.header}>
        <Text style={styles.title}>Post-turn gate</Text>
        <Text style={data.fixed ? styles.success : styles.danger}>{data.fixed ? "Fixed" : "Error"}</Text>
      </View>
      <Text style={styles.danger} selectable>{data.error}</Text>
      {data.note ? <Text style={styles.muted}>{data.note}</Text> : null}
    </View>
  );
}

/** The `paseo logs` command for a child agent, selectable and with a Copy button (cards cannot open other agents). */
export function LogsCommand({ agentId, follow, styles }: { agentId: string; follow: boolean; styles: Styles }) {
  const command = `paseo logs ${agentId}${follow ? " -f" : ""}`;
  const [copied, setCopied] = useState<string | null>(null);
  async function copy() {
    try {
      await copyText(command);
      setCopied("Copied");
    } catch {
      setCopied("Copy failed; select the text instead");
    }
  }
  return (
    <View style={styles.command}>
      <Text style={styles.code} selectable>
        {command}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Copy command: ${command}`}
        style={styles.deny}
        onPress={() => void copy()}
      >
        <Text style={styles.denyText}>{copied ?? "Copy"}</Text>
      </Pressable>
    </View>
  );
}

export type Styles = Record<"permission" | "body" | "muted" | "danger" | "actions" | "allow" | "allowText" | "deny" | "denyText" | "command" | "code", object>;

export function PermissionPrompt({
  permission,
  styles,
  who = "Reviewer",
}: {
  permission: PermissionCard;
  styles: Styles;
  who?: string;
}) {
  const paseo = usePaseo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(action: PermissionCard["actions"][number]) {
    setBusy(true);
    setError(null);
    try {
      await paseo.agents.ref(permission.agentId).respondToPermission({
        requestId: permission.requestId,
        response:
          action.behavior === "allow"
            ? { behavior: "allow", ...(action.id ? { selectedActionId: action.id } : {}) }
            : { behavior: "deny", ...(action.id ? { selectedActionId: action.id } : {}), message: "Denied from the post-turn gate card" },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <View style={styles.permission}>
      <Text style={styles.body}>
        {who} asks: {permission.title}
      </Text>
      {permission.reason ? <Text style={styles.danger}>Needs you: {permission.reason}</Text> : null}
      {permission.detail ? (
        <Text style={styles.muted} selectable>
          {permission.detail}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {permission.actions.map((action) => (
          <Pressable
            key={`${action.behavior}-${action.id}-${action.label}`}
            accessibilityRole="button"
            accessibilityLabel={`${action.label}: ${permission.title}`}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            style={action.behavior === "allow" ? styles.allow : styles.deny}
            onPress={() => void answer(action)}
          >
            <Text style={action.behavior === "allow" ? styles.allowText : styles.denyText}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
      {permission.kind === "tool" ? (
        <Text style={styles.muted}>Denying ends the {who.toLowerCase()}'s turn on some providers (e.g. kiro).</Text>
      ) : null}
      {error ? <Text style={styles.danger}>{error}</Text> : null}
    </View>
  );
}
