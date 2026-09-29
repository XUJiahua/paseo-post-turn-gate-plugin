#!/usr/bin/env node
// Creates or updates the Paseo agent profiles used by the post-turn gate
// (reviewer, verifier and answerer), then reloads the daemon so they take effect.
//
//   node scripts/create-agent-profiles.mjs --provider kiro --model claude-opus-4.8 [options]
//
// Profiles live in the daemon config at daemon.agentProfiles. This script edits
// that file through `paseo daemon config`, so it only targets a local daemon home.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const ROLES = {
  reviewer: {
    id: "post-turn-gate-reviewer",
    name: "Gate reviewer",
    icon: "eye",
    notes:
      "Independent code review after an agent turn: correctness, regressions, error handling, security, tests, maintainability. Used by the post-turn-gate plugin.",
  },
  answerer: {
    id: "post-turn-gate-answerer",
    name: "Gate answerer",
    icon: "compass",
    notes:
      "Answers an agent's questions on the user's behalf when the request and repository settle them; escalates product, risky or personal decisions. Used by the post-turn-gate plugin.",
  },
  verifier: {
    id: "post-turn-gate-verifier",
    name: "Gate verifier",
    icon: "testTube",
    notes:
      "Independent verification after an agent turn: maps each requirement to evidence, builds and runs tests. Used by the post-turn-gate plugin.",
  },
};

const USAGE = `Usage: node scripts/create-agent-profiles.mjs --provider <id> --model <id> [options]

Options:
  --provider <id>    Provider id, e.g. kiro, codex, claude (required)
  --model <id>       Model id for that provider (required)
  --mode <id>        Provider mode (default: provider default)
  --thinking <id>    Thinking option (default: model default)
  --feature k=v      Feature value, repeatable; v is parsed as JSON when possible
  --role <role>      reviewer | verifier | answerer | all (default: all)
  --id <id>          Profile id (only with a single --role)
  --name <name>      Profile name (only with a single --role)
  --home <path>      Local daemon home (default: ~/.paseo)
  --no-validate      Skip checking provider/model/mode against the daemon
  --no-reload        Do not run \`paseo daemon reload\` afterwards
  --dry-run          Print the resulting profiles without writing them
  -h, --help         Show this help`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function paseo(args, { json = true } = {}) {
  try {
    const out = execFileSync("paseo", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return json ? JSON.parse(out) : out;
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    fail(`paseo ${args.join(" ")} failed: ${detail}`);
  }
}

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    mode: { type: "string" },
    thinking: { type: "string" },
    feature: { type: "string", multiple: true, default: [] },
    role: { type: "string", default: "all" },
    id: { type: "string" },
    name: { type: "string" },
    home: { type: "string" },
    "no-validate": { type: "boolean", default: false },
    "no-reload": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!values.provider || !values.model) fail(`--provider and --model are required\n\n${USAGE}`);
const roles =
  values.role === "all" ? Object.keys(ROLES) : values.role === "both" ? ["reviewer", "verifier"] : [values.role];
if (!roles.every((role) => role in ROLES)) fail(`--role must be reviewer, verifier, answerer or all`);
if ((values.id || values.name) && roles.length > 1) fail("--id and --name need a single --role");

const featureValues = {};
for (const entry of values.feature) {
  const index = entry.indexOf("=");
  if (index <= 0) fail(`--feature expects key=value, got "${entry}"`);
  const raw = entry.slice(index + 1);
  try {
    featureValues[entry.slice(0, index)] = JSON.parse(raw);
  } catch {
    featureValues[entry.slice(0, index)] = raw;
  }
}

if (!values["no-validate"]) {
  const providers = paseo(["provider", "ls", "--json"]);
  const provider = providers.find((entry) => entry.provider === values.provider);
  if (!provider) fail(`unknown provider "${values.provider}". Known: ${providers.map((p) => p.provider).join(", ")}`);
  if (provider.status !== "available") console.warn(`warning: provider "${values.provider}" is ${provider.status}`);
  const models = paseo(["provider", "models", values.provider, "--json"]);
  const model = models.find((entry) => entry.id === values.model);
  if (!model) fail(`unknown model "${values.model}" for ${values.provider}. Known: ${models.map((m) => m.id).join(", ")}`);
  if (values.thinking && !model.thinkingOptionIds.includes(values.thinking)) {
    fail(`thinking "${values.thinking}" is not offered by ${values.model}. Known: ${model.thinkingOptionIds.join(", ") || "none"}`);
  }
  const modes = String(provider.modes ?? "").split(",").map((mode) => mode.trim()).filter(Boolean);
  if (values.mode && modes.length > 0 && !modes.includes(values.mode)) {
    fail(`unknown mode "${values.mode}" for ${values.provider}. Known: ${modes.join(", ")}`);
  }
}

const homeArgs = values.home ? ["--home", values.home] : [];
const current = paseo(["daemon", "config", "get", "daemon.agentProfiles", ...homeArgs]);
const profiles = Array.isArray(current.value) ? [...current.value] : [];

const written = roles.map((role) => {
  const preset = ROLES[role];
  const profile = {
    id: values.id ?? preset.id,
    name: values.name ?? preset.name,
    icon: preset.icon,
    provider: values.provider,
    model: values.model,
    ...(values.mode ? { modeId: values.mode } : {}),
    ...(values.thinking ? { thinkingOptionId: values.thinking } : {}),
    ...(Object.keys(featureValues).length ? { featureValues } : {}),
    notes: preset.notes,
  };
  const index = profiles.findIndex((existing) => existing.id === profile.id);
  const clash = profiles.find((existing) => existing.id !== profile.id && existing.name === profile.name);
  if (clash) console.warn(`warning: another profile (${clash.id}) is also named "${profile.name}"; reference it by id`);
  // Replace the launch settings this script owns; keep fields it does not own (e.g. a colour picked in Settings).
  const OWNED = ["id", "name", "icon", "provider", "model", "modeId", "thinkingOptionId", "featureValues", "notes"];
  if (index === -1) profiles.push(profile);
  else {
    const kept = Object.fromEntries(Object.entries(profiles[index]).filter(([key]) => !OWNED.includes(key)));
    profiles[index] = { ...kept, ...profile };
  }
  return { role, profile, action: index === -1 ? "created" : "updated" };
});

if (values["dry-run"]) {
  console.log(JSON.stringify(profiles, null, 2));
  process.exit(0);
}

// ponytail: read-modify-write of the whole array; a profile saved in Settings at the same
// instant could be lost. Upgrade path: a daemon RPC that upserts one profile.
paseo(["daemon", "config", "set", "daemon.agentProfiles", JSON.stringify(profiles), ...homeArgs]);
if (!values["no-reload"]) paseo(["daemon", "reload", ...homeArgs], { json: false });

for (const { role, profile, action } of written) {
  console.log(`${action} ${role} profile "${profile.name}" (id: ${profile.id}) → ${profile.provider}/${profile.model}`);
}
const example = written[0];
console.log(`
Profiles are opt-in. To use one, set it in .paseo/post-turn-gate.json:
  "agents": { "${example.role}": { "profile": "<id or name>" } }`);
