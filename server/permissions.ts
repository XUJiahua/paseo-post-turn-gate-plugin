// Decides which permission requests of gate-managed agents are approved without a human.
// The gate exists to cut repeated confirmations, so routine work (reading, building, testing,
// editing inside the repository) is approved; anything irreversible, outward-facing, or
// privilege-changing is left for the user to answer on the card.
import path from "node:path";

export interface PermissionLike {
  kind: string;
  name?: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: unknown;
  actions?: ReadonlyArray<{ id: string; behavior: "allow" | "deny" }>;
}

// ponytail: pattern list plus a small tokenizer, not a shell parser; an obfuscated command (eval, base64,
// variables) can slip through. The ceiling is the same as the source agent's mode; upgrade path is a
// provider-level sandbox profile for reviewers.
const DANGEROUS: ReadonlyArray<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b/i, "recursive delete"],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s|restore\s|rebase|filter-branch|tag\s+-d)\b/i, "destructive or remote git operation"],
  [/\bgit\s+commit\b.*--amend\b/i, "history rewrite"],
  [/\b(sudo|su|doas)\b/i, "privilege escalation"],
  [/\bchmod\s+-R\b|\bchown\b/i, "permission change"],
  [/\b(npm|pnpm|yarn|cargo|gem|twine)\s+publish\b|\bgh\s+(release|pr\s+(create|merge)|repo\s+delete)\b/i, "publishing"],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python)/i, "piping a download into a shell"],
  [/\b(drop\s+(table|database)|truncate\s+table|delete\s+from)\b/i, "destructive SQL"],
  [/\bdd\s+if=|\bmkfs\b|\bshutdown\b|\breboot\b|\bkillall\b/i, "system-level command"],
  [/(^|\s)>\s*\/(etc|usr|bin|System)\b/i, "writing outside the repository"],
  [/(^|[\s/'"=])\.env\b|\.(pem|p12|key)\b|\bid_(rsa|ed25519)\b|\.aws\/credentials|\.netrc\b/i, "secret or credential file"],
];

// Conservative: any word of a simple command that names a cloud or deploy tool (by basename) needs a human,
// whatever prefix runs it (`timeout 60 aws …`, `watch kubectl …`, `env -u X terraform …`). The only exception
// is a read-only program whose arguments are paths or search terms: `cat src/aws/client.ts`, `ls infra/terraform`.
const CLOUD_TOOLS = new Set(["kubectl", "helm", "terraform", "pulumi", "aws", "gcloud", "az", "flyctl", "vercel", "netlify"]);
const READ_ONLY = new Set(["cat", "less", "more", "head", "tail", "ls", "tree", "wc", "file", "stat", "grep", "egrep", "fgrep", "rg", "ag", "diff"]);
// Prefixes that run the next word as the program.
const WRAPPERS = new Set(["env", "command", "exec", "time", "nice", "nohup", "npx", "pnpx", "bunx", "xargs"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
// git global options that take a value as the next word (`git -C /repo push`).
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);

function tokenize(command: string): string[][] {
  const segments: string[][] = [];
  let argv: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  const endWord = () => {
    if (word !== null && word !== "$") argv.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (argv.length > 0) segments.push(argv);
    argv = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) word = (word ?? "") + command[++index];
      else word = (word ?? "") + char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\" && index + 1 < command.length) {
      word = (word ?? "") + command[++index];
    } else if (/\s/.test(char) && char !== "\n") {
      endWord();
    } else if (";&|\n()`".includes(char)) {
      endSegment();
    } else {
      word = (word ?? "") + char;
    }
  }
  endSegment();
  return segments;
}

/**
 * Splits a shell command into the simple commands it runs, each as argv with the program's basename first:
 * environment assignments and wrappers (env, npx, …) are dropped, `sh -c` scripts are expanded, and git's
 * global options are removed so `git -C /repo push` reads as `git push`.
 */
export function commandSegments(command: string, depth = 0): string[][] {
  const result: string[][] = [];
  for (let argv of tokenize(command)) {
    for (;;) {
      while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv = argv.slice(1);
      if (argv.length === 0 || !WRAPPERS.has(path.basename(argv[0]))) break;
      argv = argv.slice(1);
      while (argv.length > 0 && argv[0].startsWith("-")) argv = argv.slice(1);
    }
    if (argv.length === 0) continue;
    const program = path.basename(argv[0]);
    const script = argv.findIndex((arg, index) => index > 0 && /^-[a-z]*c$/.test(arg));
    if (SHELLS.has(program) && script !== -1 && argv[script + 1] && depth < 3) {
      result.push(...commandSegments(argv[script + 1], depth + 1));
      continue;
    }
    let rest = argv.slice(1);
    if (program === "git") {
      while (rest.length > 0 && rest[0].startsWith("-")) rest = rest.slice(GIT_VALUE_OPTIONS.has(rest[0]) ? 2 : 1);
    }
    result.push([program, ...rest]);
  }
  return result;
}

/** The first risk found in a command, checking both its raw text and its normalized simple commands. */
function commandRisk(command: string): string | null {
  const segments = commandSegments(command).map((argv) =>
    // Titles read like "Running: grep -rn helm …": the label is not the program.
    argv.length > 1 && argv[0].endsWith(":") ? commandSegments(argv.slice(1).join(" ")).flat() : argv,
  );
  // A word that is itself a script (`node -e "…execSync('kubectl …')"`, `python3 -c "os.system('aws …')"`) is
  // tokenized again, so a tool named inside it is found like one on the command line.
  const namesTool = (words: readonly string[], depth = 0): boolean =>
    words.some(
      (word) =>
        CLOUD_TOOLS.has(path.basename(word)) ||
        (depth < 3 && /[\s;&|()'"`]/.test(word) && namesTool(tokenize(word).flat(), depth + 1)),
    );
  if (segments.some((argv) => !READ_ONLY.has(argv[0]) && namesTool(argv))) {
    return "cloud or deployment tool";
  }
  for (const text of [command, ...segments.map((argv) => argv.join(" "))]) {
    for (const [pattern, reason] of DANGEROUS) {
      if (pattern.test(text)) return reason;
    }
  }
  return null;
}

// Natural-language red flags for answers given on the user's behalf (second check after the answerer).
const RISKY_ANSWER =
  /\bforce[- ]push|\bdeploy(ing)? to (prod|production|staging)|\bpublish(ing)? (to|on) (npm|pypi|crates|the store)|\bdrop (the )?(table|database)|\bdelete (the )?(database|data|branch|repo(sitory)?|bucket|production|user data)|\b(password|credential|secret|api[ -]?key|private key)s?\b|\b(pay|purchase|billing|credit card)\b|\bpush(ing)? (it|this|them|the (branch|changes|commits?)|to (origin|main|master|the remote|github))\b|\bdeploy(ing)? (it|this|now)\b|\bapply(ing)? (the )?(terraform|pulumi|infra(structure)?) (plan|changes)\b|\b(run|apply)(ning)? (the )?migrations? (on|against|to|in) (prod|production|staging)\b|\broll(ing)? ?out (to|on) (prod|production)\b|删除(数据|分支|仓库)|强制推送|推送到|发布到|部署到|密码|密钥|付费|付款/i;

/**
 * The commands a question or answer names: fenced code lines, `inline` spans, `$ ` lines, and the clause after
 * "run"/"执行" in prose ("Yes, run aws s3 rm …"). A tool named in plain prose ("use the AWS SDK") is not one.
 */
function commandSpans(text: string): string[] {
  const spans: string[] = [];
  const prose = text.replace(/```[^\n]*\n?([\s\S]*?)(```|$)/g, (_match, body: string) => {
    spans.push(...body.split("\n"));
    return " ";
  });
  for (const match of prose.matchAll(/`+([^`\n]+?)`+/g)) spans.push(match[1]);
  for (const match of prose.matchAll(/^\s*\$\s+(.+)$/gm)) spans.push(match[1]);
  for (const match of prose.replace(/`/g, "").matchAll(/(?:\brun|\bexecute|运行|执行)\s*[:：]?\s*([^.,;!?。，；！？\n]+)/gi)) {
    spans.push(match[1]);
  }
  return spans.map((span) => span.trim()).filter(Boolean);
}

/**
 * Why an auto-answer must go to the user instead; null when nothing risky was found. A backstop for an answerer
 * that misjudged its scope: the risk is an answer authorizing an irreversible or outward-facing action, so only
 * commands and action phrases count, not a tool's name in prose.
 */
export function answerRisk(text: string): string | null {
  for (const span of commandSpans(text)) {
    const risk = commandRisk(span);
    if (risk) return risk;
  }
  for (const [pattern, reason] of DANGEROUS) {
    if (pattern.test(text)) return reason;
  }
  return RISKY_ANSWER.test(text) ? "involves an irreversible, outward-facing or credential decision" : null;
}

function requestTexts(request: PermissionLike): string[] {
  const detail = request.detail as { command?: unknown; filePath?: unknown } | undefined;
  const input = request.input ?? {};
  const text = (value: unknown) =>
    typeof value === "string" ? value : Array.isArray(value) && value.every((part) => typeof part === "string") ? value.join(" ") : null;
  return [
    request.title,
    request.description,
    text(detail?.command),
    text(detail?.filePath),
    text(input.command),
    text(input.cmd),
    text(input.path),
    text(input.file_path),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export type AutoDecision =
  | { approve: true; actionId: string | undefined }
  | { approve: false; reason: string };

export function decideAutoApproval(request: PermissionLike, repoRoot: string): AutoDecision {
  // Plans, questions and mode switches are decisions, not routine tool use.
  if (request.kind !== "tool") return { approve: false, reason: `${request.kind} request needs a human decision` };
  for (const text of requestTexts(request)) {
    const reason = commandRisk(text);
    if (reason) return { approve: false, reason };
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
