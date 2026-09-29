import type { ReviewerSpec } from "../shared/schema.ts";

/** The provider-scoped launch settings shared by agents, profiles, and policy overrides. */
export interface LaunchConfig {
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export interface AgentProfileLike {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export type ResolvedReviewer =
  | { ok: true; config: LaunchConfig & { model: string }; source: string }
  | { ok: false; error: string };

function findProfile(profiles: readonly AgentProfileLike[], ref: string): AgentProfileLike | string {
  const byId = profiles.find((profile) => profile.id === ref);
  if (byId) return byId;
  const byName = profiles.filter((profile) => profile.name === ref);
  if (byName.length === 1) return byName[0];
  const names = profiles.map((profile) => `"${profile.name}" (${profile.id})`).join(", ") || "none";
  return byName.length > 1
    ? `agent profile name "${ref}" is ambiguous; use its id. Profiles: ${names}`
    : `agent profile "${ref}" not found. Profiles: ${names}`;
}

/**
 * Layers the reviewer config: source agent → agent profile → explicit policy fields.
 * Model, mode, thinking and features are provider-specific, so a layer that switches
 * provider drops everything inherited from lower layers instead of mixing them.
 */
export function resolveReviewer(
  source: LaunchConfig,
  spec: Partial<ReviewerSpec>,
  profiles: readonly AgentProfileLike[],
): ResolvedReviewer {
  const layers: Array<{ label: string; config: Partial<LaunchConfig> }> = [];
  if (spec.profile) {
    const profile = findProfile(profiles, spec.profile);
    if (typeof profile === "string") return { ok: false, error: profile };
    layers.push({ label: `profile "${profile.name}"`, config: profile });
  }
  const explicit: Partial<LaunchConfig> = {
    ...(spec.provider ? { provider: spec.provider } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.mode ? { modeId: spec.mode } : {}),
    ...(spec.thinking ? { thinkingOptionId: spec.thinking } : {}),
    ...(spec.features ? { featureValues: spec.features } : {}),
  };
  if (Object.keys(explicit).length > 0) layers.push({ label: "policy reviewer", config: explicit });

  let config: LaunchConfig = { ...source };
  let label = "source agent";
  for (const layer of layers) {
    if (layer.config.provider && layer.config.provider !== config.provider) {
      config = { provider: layer.config.provider };
    }
    config = {
      ...config,
      ...(layer.config.model ? { model: layer.config.model } : {}),
      ...(layer.config.modeId ? { modeId: layer.config.modeId } : {}),
      ...(layer.config.thinkingOptionId ? { thinkingOptionId: layer.config.thinkingOptionId } : {}),
      ...(layer.config.featureValues
        ? { featureValues: { ...config.featureValues, ...layer.config.featureValues } }
        : {}),
    };
    label = layer.label;
  }
  if (!config.model) {
    return { ok: false, error: `no model resolved for provider "${config.provider}" (from ${label}); set reviewer.model` };
  }
  return { ok: true, config: { ...config, model: config.model }, source: label };
}
