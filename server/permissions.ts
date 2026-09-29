// Decides which permission requests of gate-managed agents are approved without a human.
// The gate exists to cut repeated confirmations, so routine work (reading, building, testing,
// editing inside the repository) is approved; anything irreversible, outward-facing, or
// privilege-changing is left for the user to answer on the card.

export interface PermissionLike {
  kind: string;
  name?: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: unknown;
  actions?: ReadonlyArray<{ id: string; behavior: "allow" | "deny" }>;
}

// ponytail: pattern list, not a shell parser; an obfuscated command (eval, base64, variables)
// can slip through. The ceiling is the same as the source agent's mode; upgrade path is a
// provider-level sandbox profile for reviewers.
const DANGEROUS: ReadonlyArray<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b/i, "recursive delete"],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s|restore\s|rebase|filter-branch|tag\s+-d)\b/i, "destructive or remote git operation"],
  [/\bgit\s+commit\b.*--amend\b/i, "history rewrite"],
  [/\b(sudo|su|doas)\b/i, "privilege escalation"],
  [/\bchmod\s+-R\b|\bchown\b/i, "permission change"],
  [/\b(npm|pnpm|yarn|cargo|gem|twine)\s+publish\b|\bgh\s+(release|pr\s+(create|merge)|repo\s+delete)\b/i, "publishing"],
  [/\b(kubectl|helm|terraform|pulumi|aws|gcloud|az|flyctl|vercel|netlify)\b/i, "cloud or deployment tool"],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python)/i, "piping a download into a shell"],
  [/\b(drop\s+(table|database)|truncate\s+table|delete\s+from)\b/i, "destructive SQL"],
  [/\bdd\s+if=|\bmkfs\b|\bshutdown\b|\breboot\b|\bkillall\b/i, "system-level command"],
  [/(^|\s)>\s*\/(etc|usr|bin|System)\b/i, "writing outside the repository"],
  [/(^|[\s/'"=])\.env\b|\.(pem|p12|key)\b|\bid_(rsa|ed25519)\b|\.aws\/credentials|\.netrc\b/i, "secret or credential file"],
];

// Natural-language red flags for answers given on the user's behalf (second check after the answerer).
const RISKY_ANSWER =
  /\bforce[- ]push|\bdeploy(ing)? to (prod|production|staging)|\bpublish(ing)? (to|on) (npm|pypi|crates|the store)|\bdrop (the )?(table|database)|\bdelete (the )?(database|data|branch|repo(sitory)?|bucket|production|user data)|\b(password|credential|secret|api[ -]?key|private key)s?\b|\b(pay|purchase|billing|credit card)\b|删除(数据|分支|仓库)|强制推送|发布到|部署到|密码|密钥|付费|付款/i;

/** Why an auto-answer must go to the user instead; null when nothing risky was found. */
export function answerRisk(text: string): string | null {
  for (const [pattern, reason] of DANGEROUS) {
    if (pattern.test(text)) return reason;
  }
  return RISKY_ANSWER.test(text) ? "involves an irreversible, outward-facing or credential decision" : null;
}

function requestText(request: PermissionLike): string {
  const detail = request.detail as { command?: unknown; filePath?: unknown } | undefined;
  const input = request.input ?? {};
  return [
    request.title,
    request.description,
    typeof detail?.command === "string" ? detail.command : null,
    typeof detail?.filePath === "string" ? detail.filePath : null,
    typeof input.command === "string" ? input.command : null,
    typeof input.cmd === "string" ? input.cmd : null,
    typeof input.path === "string" ? input.path : null,
    typeof input.file_path === "string" ? input.file_path : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export type AutoDecision =
  | { approve: true; actionId: string | undefined }
  | { approve: false; reason: string };

export function decideAutoApproval(request: PermissionLike, repoRoot: string): AutoDecision {
  // Plans, questions and mode switches are decisions, not routine tool use.
  if (request.kind !== "tool") return { approve: false, reason: `${request.kind} request needs a human decision` };
  const text = requestText(request);
  for (const [pattern, reason] of DANGEROUS) {
    if (pattern.test(text)) return { approve: false, reason };
  }
  const filePath = (request.detail as { filePath?: unknown } | undefined)?.filePath;
  if (typeof filePath === "string" && filePath.startsWith("/") && !filePath.startsWith(repoRoot)) {
    return { approve: false, reason: "file outside the repository" };
  }
  // Prefer a one-time allow so nothing is persisted as a standing grant.
  const allow = request.actions?.find((action) => action.id === "allow_once")
    ?? request.actions?.find((action) => action.behavior === "allow");
  if (request.actions && request.actions.length > 0 && !allow) return { approve: false, reason: "no allow option offered" };
  return { approve: true, actionId: allow?.id };
}
