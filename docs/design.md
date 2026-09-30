# Post-Turn Quality Gate 设计（MVP）

基于 Paseo lifecycle hook 的纯插件实现：Agent 完成一轮后，按仓库策略启动独立 Verifier / Reviewer，结果回写原 Agent timeline，可选自动修复。原始方案见 [issue #1](https://github.com/XUJiahua/paseo-post-turn-gate-plugin/issues/1)，本文按源码与实测结果对其做了修正。

- 目标 Paseo 版本：`>=0.10.0`。验证基于 paseo `3b4118360`（server 0.10.0）和本机 Paseo Desktop 0.10.1。
- 对 provider 不做限制：Reviewer 默认继承源 Agent 的配置（含 mode），也可以通过 Paseo agent profile 或显式字段覆盖（§3.1）；不强制只读。已在真实环境验证的只有 **kiro-cli**（2.25.0）；Codex 的 provider 差异已适配并有单测，真实 Codex / Claude 冒烟项见 §15。

## 1. 已验证的平台行为

验证方式：

- **实测**：在 paseo 仓库用自带 e2e harness（`createTestPaseoDaemon`）加载探针插件。V1–V15 用 fake provider；K1–K13 用真实 `kiro-cli acp`。探针已删除。
- **源码**：只读代码确认。

### 1.1 通用行为

| # | 行为 | 结论 | 依据 |
|---|---|---|---|
| V1 | `PluginServerContext` 是否带 `paseo` | 不带。可用的键只有 `before, handle, on, registerProvider, registerSettings, registerUsageSource` | 实测 |
| V2 | hook 中 `event.agent` 的字段 | 只有 `id, workspaceId, parentAgentId, provider, cwd, title`，**没有 labels** | 实测 |
| V3 | `turn_started` / `turn_ended` 的时序 | 按顺序到达，但 handler **并发执行**：`turn_started` handler 还在 await，5ms 后 `turn_ended` 就进来了 | 实测 |
| V4 | hook 超时 | 30s 超时后 abort `signal`；事件是 best-effort，不重放 | 源码 |
| V5 | `send()` 遇到运行中的 turn | 原 turn 变为 `canceled`，新 turn 立即开始（`replaceRunning`） | 实测 |
| V6 | `send(text, { messageId })` | timeline 中 `user_message.messageId === clientMessageId === 传入值`，并出现在 `turn_ended.timeline` 里 | 实测 |
| V7 | 用 `prompt + clientMessageId` 创建 | 同样生成带 `messageId` 的 `user_message` | 实测 |
| V8 | `workspaces.ref(id).agents.create({ agentId, idempotencyKey, parent, labels, prompt, config })` | 落在同一 workspace，指定的 id 生效；labels 保留，并自动加上 `paseo.parent-agent-id`；`featureValues` 生效 | 实测 |
| V9 | 同 key 重放 | 返回同一个 agent，**不重发 prompt**；同 key 但 payload 不同 → `agent_request_key_conflict` | 实测 |
| V10 | daemon 重启后同 key 重放 | 返回同一个 agent，prompt 不重发（receipt 持久化在 `$PASEO_HOME/creations`） | 实测 |
| V11 | 创建中途中断后重放 | 若中断在 prompt 阶段 → `failed + outcomeUnknown`，不重发 | 源码及单测 |
| V12 | `config.provider` 格式 | 必须是 `provider/model` | 实测 |
| V13 | `refresh()` 快照 | 包含 `provider, model, currentModeId, thinkingOptionId, features[], availableModes[], labels, status, workspaceId, archivedAt` | 实测 |
| V14 | 同 id 调用 `timeline.append` | 只保留一行，内容为最新数据 | 实测 |
| V15 | `timeline.refetch` 的条目 | 包含 `seqStart, seqEnd, turnId`；每页带 `epoch` | 实测 |
| V16 | timeline renderer 的 props | 没有 `navigation`，卡片里无法 `openAgent` | 源码 |
| V17 | internal agent | 不触发插件事件 | 源码 |
| V18 | daemon 运行时里的 `node:sqlite` | Paseo Desktop 用 `Paseo Helper`（Node 24.20.0）fork 插件进程；`DatabaseSync` 可用，UNIQUE 冲突时抛 `ERR_SQLITE_ERROR` | 实测 |

### 1.2 kiro-cli 行为

| # | 行为 | 结论 | 依据 |
|---|---|---|---|
| K1 | lifecycle hook | `turn_started` / `turn_ended` / `permission_requested` 都会触发；`turn_ended.timeline` 中有带 `messageId` 的 `user_message` 和 `tool_call` | 实测 |
| K2 | mode 与 kiro agent 的关系 | Paseo 的 mode 就是 kiro agent 名，`~/.kiro/agents/*.json` 会出现在 `availableModes` 中。创建时传 `modeId: "ptg-reviewer"`，`currentModeId` 即为该值 | 实测 |
| K3 | 源 Agent 快照 | `model: "claude-opus-4.8"`，`currentModeId: "kiro_default"`，`thinkingOptionId: null`，`features: [auto_accept=false]`。用 `provider: "kiro/<model>"` 创建成功 | 实测 |
| K4 | `outputSchema` | ACP 适配层会**静默忽略**，不报错也不生效 | 源码 `acp-agent.ts` |
| K5 | 纯文本 JSON verdict | 按 prompt 要求，最后一条 `assistant_message` 是**不带代码块的纯 JSON**，可以直接 `JSON.parse`，结构符合契约（3/3 次） | 实测 |
| K6 | 拒绝权限请求 | 即使选择 `reject_once`，kiro 也会**直接结束整轮**（`canceled: Interrupted`），不会输出 verdict | 实测 |
| K7 | `tools` 不含 `write` | 模型没有写文件的工具，不会尝试写 | 实测 |
| K8 | `shell` + `allowedCommands` + `denyByDefault: true` | 名单外的命令被 kiro **直接拒绝，不弹权限请求**，模型收到 “Command not in allowed list” 后继续这一轮；`git status > pwn1.txt` 这类重定向会被拒；`git log` 正常放行 | 实测 |
| K9 | 源 Agent 使用 `kiro_default` | 写文件时会发权限请求（本次探针自动放行） | 实测 |
| K10 | Reviewer 完整继承源 Agent 配置 | 用 `provider: "kiro/claude-opus-4.8"`、`modeId: "kiro_default"`、`featureValues: { auto_accept: false }` 创建，子 Agent 快照中三项与源 Agent 一致 | 实测 |
| K11 | Reviewer 等待授权（`permissions: "auto"` 的依据：插件调用 `respondToPermission` 放行后这一轮继续） | 收到 `permission_requested` 时，`refresh()` 显示 `status: "running"`、`pendingPermissions.length === 1`、`attentionReason: null`。用户（探针模拟）延迟 2s 放行后收到 `permission_resolved`，这一轮继续完成 | 实测 |
| K12 | Reviewer 跑命令、改文件 | shell（`node -e …`）和 edit 均放行后执行；最后一条消息仍是可直接 `JSON.parse` 的 verdict；tree 对比得到 diffstat `reviewer-note.txt \| 1 +` | 实测 |
| K13 | fix 轮 | Reviewer 结束后源 Agent 为 `idle`；`send(text, { messageId: "ptg:run-1:fix:1" })` 触发的新轮 `turn_ended` 中，最后一条 `user_message.messageId` 即为该值；`git diff base fix` 同时包含源 Agent 的修复和 Reviewer 的改动 | 实测 |

### 1.3 归档后的可见性

| # | 行为 | 结论 | 依据 |
|---|---|---|---|
| A1 | `archive()` 之后 | `agents.list()` 默认不含该 agent；`list({ filter: { includeArchived: true } })` 包含；`refresh()` 和 `timeline.refetch()` 仍然可用 | 实测（kiro） |
| A2 | App 中的入口 | “历史”页（`fetch_agent_history_request`）会列出已归档的 agent，可以打开查看完整 timeline（只读，无同步状态） | 源码 + paseo 单测 |
| A3 | Subagents 栏 | 已归档的子 Agent **不显示**（`subagents/select.ts`） | 源码 |
| A4 | 向已归档 agent `send` | 会自动取消归档 | 源码 `agent-prompt.ts` |

### 1.4 Codex provider 适配

| # | 行为 | 处理 | 依据 |
|---|---|---|---|
| C1 | `outputSchema` | Gate 的 verdict / answer schema 原样传给 Paseo；Codex provider 会规范化后传给 `turn/start` | Paseo Codex provider 源码与单测 |
| C2 | 源 Agent 开着 `plan_mode` | reviewer、verifier、answerer 强制以 `plan_mode: false` 启动；其余 model、mode、thinking、Fast 设置照常继承 | 本插件单测；Paseo Plan 模式会在 turn 完成后产生计划确认请求 |
| C3 | Codex app-server 退出 | `Codex app-server exited …` 归类为 `crashed` | Paseo Codex transport 源码与本插件单测 |
| C4 | Codex 用量耗尽 | `You've hit your usage limit` 归类为 `quota_exhausted`，不会自动重试 | Paseo Codex real-e2e 的错误判定措辞与本插件单测 |

这些是源码/契约级适配，不替代 §15 的真实 Paseo + Codex 冒烟。

## 2. 相对原方案的修正

| 原方案 | 问题 | 修正 |
|---|---|---|
| 在 hook 中完成 Gate | 30s 超时（V4） | handler 只负责入队；整个流程事件驱动 |
| 依赖 `turn_started` 先处理完 | handler 并发（V3） | 插件内单一串行队列 |
| 从 hook 读 labels 做过滤 | hook 里没有 labels（V2） | `turn_ended` 时 `refresh()` 源 Agent 获取 |
| 启动时恢复 | 启动时拿不到 `paseo`（V1） | 懒恢复（§9） |
| 先建无 Prompt 子 Agent 再 `send` | `outputSchema` 只随初始 prompt 生效，这样做会丢掉它，还多一次竞态 | 预分配 `agentId`，先写 ledger，再带 prompt 和 `outputSchema` 一次创建（V8–V11） |
| YAML 策略 | 需要依赖和 build 步骤 | 改用 JSON：`JSON.parse` + zod（zod 由宿主提供），零依赖，无 build |
| “Reviewer 不得修改代码” | 各 provider 的只读手段各不相同（kiro 需要单独配置 agent，拒绝权限还会终止整轮，见 K6–K8）；而且 Verify 本身需要跑构建和测试 | 不强制只读，只在 prompt 中要求。review 前后对比 tree，发现改动时在卡片上**警告**并附 diffstat（§5） |
| 一个 turn 就 review 一次 | 调度型根 Agent 每轮都会触发 | `turn_started` 记录 git 基线，工作区没有变化就跳过 |
| fix 轮当作新 turn | 会产生新的 run，并重新读策略 | fix 消息带 `messageId = ptg:<run_id>:fix:<n>`（V6），据此归入原 run |
| 直接 `send` fix | 会打断用户（V5） | 源 Agent 不是 `idle` 就判 `SUPERSEDED` |
| 卡片上带子 Agent 链接 | renderer 没有 navigation（V16） | 卡片显示子 Agent 标题和 id；用户去“历史”页打开 |

## 3. 策略文件

路径：`<git toplevel>/.paseo/post-turn-gate.json`

```json
{
  "version": 2,
  "trigger": "root_and_opt_in",
  "on_fail": { "fix": { "max_rounds": 2 } },
  "agents": { "reviewer": {}, "verifier": {}, "answerer": {} },
  "on_outcome": { "done": ["review"] }
}
```

完整的默认值用 `npm run init` 生成；它同时为每个角色生成可直接生效的仓库规则 `.paseo/post-turn-gate/<role>.md`。文件开头的 HTML 注释只是编辑说明，插件会忽略；注释后的 Markdown 是实际提示词，默认强调先读取本仓库的文档、配置、测试和既有约定，可以按项目继续修改并提交。

| 字段 | 取值 | 默认 |
|---|---|---|
| `trigger` | `root_only` / `root_and_opt_in` / `all` | `root_and_opt_in` |
| `on_fail` | `{ "fix": { "max_rounds": 1..5 } }` / `report` | `{ "fix": { "max_rounds": 2 } }`：插件的目的是让 agent 自动循环到通过 |
| `on_outcome.done` | 检查列表（`review`、`verify` 的非空、不重复的有序组合）/ `notify` / `ignore` | `["review"]` |
| `agents.reviewer` / `agents.verifier` / `agents.answerer` | 见 §3.1 | 不使用 profile，继承源 Agent 启动配置并加载各自的仓库规则文件 |

做哪些检查只由 `on_outcome.done` 决定，其余情况（例如 `awaiting_user: "as_done"`、answerer 判断其实已完成）都归到 `done` 再处理，所以不存在"要检查却没有检查项"的组合。

多个检查按列表顺序串行执行：

- 第一个 FAIL 结束本轮；全部 PASS 才是 PASSED；有 INCONCLUSIVE 时继续后面的检查，最终为 INCONCLUSIVE。
- `on_fail` 为 fix 时只把失败那一项的 findings 发回；修复轮从第一项重新开始（修复可能破坏已通过的检查）。`max_rounds` 按整个任务计。
- run 用 `step` 记录当前检查项，`rounds_json` 每条带 `check`。只有 run 当前的子 Agent（`child_agent_id`）的结果有效，早先检查项的迟到回复会被忽略。
- 不并行：两个子 Agent 在同一工作区跑构建和测试会互相干扰，两份 findings 也难合并成一个修复提示。

- 不在 git 仓库里，或文件不存在：不执行 Gate。
- `JSON.parse` 或 zod 校验失败：不创建子 Agent，在源 timeline 写一张 `ERROR` 卡片，并附上具体错误。
- 策略在 `turn_started` 时读取并冻结；本轮内对它的修改只影响后续轮次。fix 轮沿用原 run 的快照。
- 这是质量流程，不是安全边界：Agent 可以改写策略文件，关掉后续轮次的 Gate。

### 3.1 子 Agent 配置（`agents`）

每个角色一节，字段相同：

```json
"agents": {
  "reviewer": {
    "profile": null,
    "provider": "codex", "model": "gpt-5.5", "mode": "auto-review", "thinking": "high",
    "features": { "fast_mode": false },
    "instructions": "Also check that every public function has a test.",
    "timeout_minutes": 45,
    "permissions": "auto"
  }
}
```

| 字段 | 默认 |
|---|---|
| `profile` | `null`：不用 profile，继承源 Agent 的启动配置 |
| `permissions` | `auto` |
| `timeout_minutes` | reviewer、verifier 30；answerer 10 |
| `instructions_file` | `.paseo/post-turn-gate/<role>.md`（不存在则忽略） |
| `provider`、`model`、`mode`、`thinking`、`features`、`instructions` | 无 |

写错字段名会作为配置错误显示在卡片上（`.strict()`）。

- **分层**：源 Agent → agent profile → 显式字段，上层覆盖下层。
- **profile 默认关闭**：初始化策略写入 `null`，因此默认路径不读取 Paseo profile。只有项目显式填写 id 或 name 时才使用共享 profile。旧版本生成的 `post-turn-gate-<role>` 引用在 profile 不存在时仍回退到源 Agent 并提示改为 `null`，用于兼容迁移。
- **切换 provider 时清空**：model、mode、thinking、features 都是 provider 专属的。某一层换了 provider，就丢弃从下层继承来的这些字段，不做混用。例如源 Agent 是 kiro，profile 是 codex：只用 profile 里的值，不会把 kiro 的 mode 带过去。
- **Codex Plan mode 例外**：Gate 托管的三个角色都必须输出结构化结果，因此最终 provider 为 `codex` 且存在 `plan_mode` 时会强制设为 `false`；Fast 等其他 feature 保持分层后的值。
- **缺 model 即报错**：最终没有 model（例如只写了 `"provider": "claude"`）→ `ERROR`，提示设置 `model`。Paseo 创建时要求 `provider/model` 格式（V12）。
- **profile 引用**：先按 id 精确匹配，再按 name 精确匹配；name 重名 → `ERROR`，要求改用 id。profile 不存在 → `ERROR`，并列出现有 profile。
  - profile 存在 daemon 配置的 `daemon.agentProfiles` 里，插件在每次 dispatch 时用 `paseo.config.get()` 读取。已用测试 daemon 实测：插件会话有读取权限，profile（claude / `bypassPermissions`）会原样用于创建 Verifier。
  - profile 只提供启动设置，不带 `systemPrompt`。角色 prompt 始终由插件的内置职责/JSON 契约与仓库中的 `instructions_file` / `instructions` 组成。
- **`instructions_file`**：仓库里的规则文件（相对 git 根目录），默认 `.paseo/post-turn-gate/<role>.md`。默认路径不存在时视为没有规则；自己写的路径必须存在且在仓库内，否则配置错误。`null` 关闭。
- **`instructions`**：内联规则，接在文件内容之后。两者合计不超过 20000 字符，追加在内置角色 prompt 之后、JSON 输出约束之前，不能替换结论格式。
- 规则文件在 `turn_started` 时和策略一起读取并冻结到 run/chain 里：Agent 在本轮改规则文件，不影响对本轮的检查。
- **`timeout_minutes`**：包括等待授权的时间。reviewer / verifier 超时判 `ERROR`；answerer 超时把问题交给用户。

#### 创建 profile 的脚本

`scripts/create-agent-profiles.mjs`（`npm run profiles -- …`）可选地创建或更新三个共享启动 profile：`post-turn-gate-reviewer`（Gate reviewer）、`post-turn-gate-verifier`（Gate verifier）和 `post-turn-gate-answerer`（Gate answerer）。创建后仍需在目标项目的 `agents.<role>.profile` 中显式填写 id 或 name 才会使用。

```bash
npm run profiles -- --provider kiro --model claude-opus-4.8 --mode kiro_default
npm run profiles -- --provider codex --model gpt-5.5 --role reviewer --thinking high
```

- 通过 `paseo provider ls/models --json` 校验 provider、model、mode、thinking 是否存在；
- 通过 `paseo daemon config get/set daemon.agentProfiles` 按 id upsert：只替换脚本负责的字段，保留用户在 Settings 里改过的其他字段（如 color）；
- 最后执行 `paseo daemon reload`（`daemon.agentProfiles` 支持热加载）；
- 支持 `--dry-run`、`--no-reload`、`--home`；只作用于本地 daemon。

`ponytail:` 写入方式是整个数组读出、修改、写回。如果恰好同时在 Settings 里保存 profile，可能丢失一次修改；更好的做法是 daemon 提供单条 upsert 的 RPC。

## 4. 流程

### 4.1 事件处理（全部经过串行队列）

```text
turn_started(agent)
  ├─ agent 是 ledger 中某个 run 的子 Agent → 忽略
  ├─ 该源 Agent 有 REVIEWING/DISPATCHING 的 run → 旧 run 标 SUPERSEDED，其 base_tree 和请求写入 ledger 的 carries 表留给下一轮
  ├─ trigger=root_only 且 parentAgentId≠null → 忽略
  └─ 读取策略、计算基线 tree → 存入内存 pending[agentId] = { policy, baseTree, repoRoot }；同一 repo 有 carry 时用它替换基线
     （carry 在这一轮结束、结果交给 run 或 chain 后才删除；插件中途重启也不会丢）

turn_ended(agent, outcome, timeline)
  ├─ agent 是 ledger 中某个 run 的子 Agent → finalizeReview(run, outcome, timeline)
  ├─ 最后一条 user_message.messageId 以 "ptg:" 开头 → onFixTurnEnded(run, outcome)
  ├─ outcome ≠ completed → 丢弃 pending，结束
  ├─ 没有 pending（例如插件中途重载）→ 记日志，结束
  ├─ 策略为 none 或无效 → 结束（无效时写 ERROR 卡片）
  ├─ refresh() 源 Agent → 按 labels + trigger 过滤（managed=true 永远跳过）
  ├─ 计算 endTree；与 baseTree 相同 → 结束
  └─ claim：INSERT gate_runs（source_turn_key UNIQUE）；冲突 → 结束；成功 → dispatch(run, round=1)
```

`source_turn_key = <agentId>:<lastUser.messageId>`。缺少 messageId 时退化为 `<agentId>:turn:<turnId>:<timeline.length>`。

判断“ptg:”前缀时，还要确认对应 run 确实存在且处于 `FIXING`，避免用户伪造 messageId。

### 4.2 派发

```text
dispatch(run, round):
  src = refresh(source)
  childId = randomUUID(); key = "ptg:<run_id>:<round>"
  ledger: status=DISPATCHING, child_agent_id=childId, round
  timeline.append(卡片 RUNNING)
  paseo.workspaces.ref(workspaceId).agents.create({
    agentId: childId, idempotencyKey: key, parent: sourceId,
    config: { provider: `${src.provider}/${src.model}`,
              modeId: src.currentModeId ?? undefined,
              thinkingOptionId: src.thinkingOptionId ?? undefined,
              featureValues: featuresOf(src) },
    title: `Gate ${action} #${round} · ${src.title ?? sourceId.slice(0, 8)}`,
    prompt, clientMessageId: key, outputSchema: VERDICT_JSON_SCHEMA,
    labels: { "post-turn-gate.managed": "true", "post-turn-gate.role": action,
              "post-turn-gate.run-id": run_id },
  })
  ledger: status=REVIEWING
```

- 配置按 §3.1 分层解析：默认完整继承源 Agent 的 provider、model、mode、thinking、features（K3、K10 已在 kiro 上验证）；解析失败（profile 不存在、缺 model）→ `ERROR`。
- `outputSchema` 一律传入：codex、opencode 和插件 provider 会生效；ACP（kiro）会忽略它（K4，已实测）；claude provider 的源码中也没有处理它，因此仍然依赖文本解析兜底。
- prompt 由插件内置（verify / review 两个角色），包含：
  - 原始需求（源 turn 的 `user_message` 文本，保存在 ledger 中）；
  - 仓库根目录；
  - 改动范围：两个 tree sha，要求模型用 `git diff <base> <end>` 查看；
  - “不要修改文件”（只是约束，不强制）；
  - 只输出纯 JSON 的要求（K5）。
- ledger 在创建之前写入。崩溃后可以用同一个 id 和 key 重放，不会重复发 prompt（V9、V10）。
- 权限请求：插件**不代为作答**，交给用户处理，和源 Agent 的体验一致。插件监听子 Agent 的 `permission_requested` / `permission_resolved`，把卡片切换为“等待授权”或恢复“进行中”。不代为拒绝，是因为 kiro 收到拒绝会直接终止整轮（K6）。

### 4.3 结果处理

```text
finalizeReview(run, outcome, childTimeline):
  run 已是终态 → 忽略
  outcome ≠ completed → ERROR("reviewer turn <kind>")
  afterTree ≠ end_tree → 记录 reviewer_changes = git diff --stat end_tree afterTree（只警告，不改判）
  解析最后一条 assistant_message 为 Verdict；失败 → ERROR（不得当作 PASS）
  PASS → PASSED
  INCONCLUSIVE → INCONCLUSIVE
  FAIL:
    report → FAILED
    fix 且 round-1 < fix.max_rounds → sendFix
    否则 → NEEDS_HUMAN
  每次状态变化后：更新卡片；状态为终态 → 归档子 Agent（§6）
```

解析顺序：先对整段文本 `JSON.parse`（K5 实测命中）；失败时取最后一个 ```json 代码块；最后用 zod 校验。

```text
sendFix(run):
  src = refresh(source)；status ≠ idle → SUPERSEDED
  ledger: status=FIXING, deadline_at=null   // 修复由源 Agent 完成，不套用角色的 timeout_minutes
  src.send(formatFindings(verdict), { messageId: "ptg:<run_id>:fix:<round>" })

onFixTurnEnded(run, outcome):
  outcome ≠ completed → SUPERSEDED（base_tree 和请求留给下一轮，见 4.1）
  end_tree = 当前 tree → dispatch(run, round + 1)   // diff 仍然以原 base_tree 为基准
```

### 4.4 基线 tree

用临时 index 给整个工作区（包括未跟踪、未被忽略的文件）拍快照，不改动真实 index 和工作区：

```text
cp --preserve=timestamps <git-path index> <tmp>      # 复用 stat 缓存；新仓库没有 index 就跳过
GIT_INDEX_FILE=<tmp> git -C <root> add -A
GIT_INDEX_FILE=<tmp> git -C <root> write-tree        → tree sha
```

- 复制真实 index 而不是 `read-tree HEAD`：后者没有 stat 缓存，每次都要重新哈希整个工作区。
- 复制时必须保留 mtime：否则 git 的 racy 检测会把同一秒内、大小不变的改动当作未修改。单测在这里踩过坑，已修复。
- 全部使用 `execFile`，不经过 shell。

## 5. Reviewer 的权限与工作区改动

Reviewer 不强制只读，与源 Agent 采用相同的权限模型：

- **能力**：继承源 Agent 的 mode，Verify 可以正常运行构建和测试。构建产物通常位于被 git 忽略的目录，不计入 tree，不会误报。
- **约束**：prompt 中明确要求不要修改文件。
- **检测**：review 前后对比 tree（§4.4）。发生变化时，卡片显示 “Reviewer 修改了 N 个文件” 和 diffstat，verdict 照常采用（K12 已在 kiro 上实测）。
  - report 模式：改动留在工作区，由用户决定是否保留；
  - fix 模式：下一轮的 `end_tree` 在修复轮结束后重新计算，Reviewer 的改动会一起进入下一次 review 的 diff 范围，不会被遗漏。
- **权限请求**：默认自动处理（`agents.<role>.permissions: "auto"`）。引入 gate 的目的就是减少人工反复确认，因此：
  - 常规工具调用（读文件、搜索、构建、跑测试、仓库内编辑）由插件以 `allow_once` 自动批准，不留长期授权；
  - 不可逆、对外、提权、涉及凭据的请求（`rm -rf`、`git push/reset --hard`、`sudo`、发布、云/部署工具、`curl | sh`、破坏性 SQL、仓库外路径、`.env`/私钥等），以及 plan、question、mode 类请求，不自动批准，显示在卡片上，附带原因和按钮，由用户决定；
  - 规则在 `server/permissions.ts`，是模式列表而不是 shell 解析器，用 `ponytail:` 注明了上限；
  - `agents.<role>.permissions: "ask"` 可恢复为每个请求都问用户；
  - 卡片显示已自动批准的次数。等待用户期间不计入超时（§9）。

`ponytail:` 这里只能事后发现改动，不能事前阻止。需要硬约束时，可以按 provider 增加只读 mode 映射，作为后续可选项。kiro 已验证可行的做法（K7、K8）：单独建一个 agent，`tools` 中不包含 `write`；shell 设置 `allowedCommands: ["git (status|diff|log|show)( .*)?"]` 和 `denyByDefault: true`；`includeMcpJson: false`。这样做的代价是 Verify 无法再运行测试。

## 6. 子 Agent 归档

run 进入终态后，插件调用 `archive()` 归档子 Agent（不使用创建参数 `autoArchive`，因为它在子 Agent 空闲时就会触发，早于插件完成解析）。

用户仍然可以查看（A1、A2）：

- 在“历史”页按标题 `Gate review #n · <源标题>` 搜索并打开，可以看到完整 timeline；
- 卡片上显示子 Agent id；
- 已归档的子 Agent 不会出现在源 Agent 的 Subagents 栏里（A3），侧栏因此保持干净；
- 向它发送消息会自动取消归档（A4）。

## 7. 状态机

```text
DISPATCHING → REVIEWING ─┬─ PASS → PASSED
                         ├─ INCONCLUSIVE → INCONCLUSIVE
                         ├─ FAIL ─┬─ report → FAILED
                         │        ├─ fix 且还有轮次 → FIXING → DISPATCHING (round+1)
                         │        └─ 轮次用尽 → NEEDS_HUMAN
                         └─ 取消 / 解析失败 / 超时 → ERROR
REVIEWING | FIXING ── 用户插话 / fix 轮被取消 ──→ SUPERSEDED
```

- 终态：`PASSED, INCONCLUSIVE, FAILED, NEEDS_HUMAN, ERROR, SUPERSEDED`。
- `round` 从 1 开始，表示第几次 review。
- 单次 review 超时固定为 30 分钟。子 Agent 有待处理的权限请求时（`pendingPermissions` 非空；等待期间 `status` 仍是 `running`，K11），每次对账都会重置截止时间。

## 8. Ledger（`node:sqlite`）

位置：`${PASEO_HOME:-~/.paseo}/plugin-data/post-turn-gate/ledger.sqlite`。V18 已验证 Paseo Desktop 运行时可用。

```sql
CREATE TABLE gate_runs (
  run_id          TEXT PRIMARY KEY,
  source_agent_id TEXT NOT NULL,
  source_turn_key TEXT NOT NULL UNIQUE,
  workspace_id    TEXT NOT NULL,
  repo_root       TEXT NOT NULL,
  policy_hash     TEXT NOT NULL,
  policy_json     TEXT NOT NULL,
  request_text    TEXT NOT NULL,
  base_tree       TEXT NOT NULL,
  end_tree        TEXT NOT NULL,
  status          TEXT NOT NULL,
  round           INTEGER NOT NULL,
  child_agent_id  TEXT,              -- 当前轮
  dispatch_json   TEXT,              -- 本轮 create 的完整参数，恢复时原样重放（同 key 必须同 payload，V9）
  deadline_at     INTEGER,
  verdict         TEXT,
  result_json     TEXT,
  reviewer_changes TEXT,             -- Reviewer 改动的 diffstat
  rounds_json     TEXT NOT NULL DEFAULT '[]',
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX gate_runs_child ON gate_runs(child_agent_id);
CREATE INDEX gate_runs_source_status ON gate_runs(source_agent_id, status);
-- 每一轮的子 Agent 在创建前登记，旧轮次子 Agent 的迟到事件也能识别为 managed
CREATE TABLE gate_children (child_agent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL);
```

在 claim 之前，`turn_started` 到 `turn_ended` 之间的策略快照只放在内存里。hook 本身不会重放，把它持久化没有意义。

## 9. 恢复与对账

- **触发时机**：第一次拿到 `context.paseo` 时（任意 hook 或 RPC）；之后只要存在未终结的 run，就每 60 秒检查一次。只扫描 ledger，不扫描历史 Agent。
- **`DISPATCHING`**：用 `dispatch_json` 中记录的同一份参数（同 id、同 key）重放 create（V9、V10）。成功 → `REVIEWING`；失败时先查询子 Agent，存在则进入 `REVIEWING`，否则 `ERROR`。如果还没来得及记录 `dispatch_json`，就重新 dispatch。
- **`REVIEWING`**：`refresh(child)`。仍在 running → 继续等（有待处理的权限请求时顺延截止时间）；已 idle → 用 `timeline.refetch({ direction: "tail" })` 取结果并 finalize；超时 → `ERROR`。
- **`FIXING`**：`refresh(source)`。已 idle 时在 timeline 中查找 `ptg:…:fix:<n>`：
  - 找不到 → 用同一个 messageId 重发；
  - 找到，但之后还有其他用户消息 → `SUPERSEDED`；
  - 找到，且之后没有其他用户消息 → `onFixTurnEnded(completed)`。

`ponytail:` 插件启动后、第一个事件到来之前不会做恢复。要彻底解决，需要给 Paseo 提 PR 暴露 `server.paseo`。

## 10. Timeline 卡片

```ts
timeline.append({ type: "plugin", id: "post-turn-gate:<run_id>:round:<round>", kind: "post-turn-gate", version: 1, data })
data = { status, action, round, maxFixRounds, waiting, summary, findings, otherFindings,
         childAgentId, childTitle, reviewerChanges, error }
```

每轮使用独立的 timeline item id：同一轮的状态原位更新，修复后的下一轮在时间线当前位置新增卡片。

`findings` 只保留阻塞项（CRITICAL/HIGH），其余只给计数，保证数据小于 64 KiB。客户端用 `addTimelineRenderer` 渲染，颜色取 `theme.colors.status*`。

## 11. 结果契约

```json
{
  "verdict": "PASS | FAIL | INCONCLUSIVE",
  "summary": "...",
  "findings": [
    { "severity": "CRITICAL | HIGH | MEDIUM | LOW", "title": "...", "evidence": "...", "suggested_fix": "..." }
  ]
}
```

- Verify：关注需求是否逐项达成，并运行构建、测试，检查可观察到的行为。
- Review：关注 correctness、regression、error handling、security、tests、maintainability。

## 12. 目录结构

```text
paseo-plugin.json          # requirements.paseo ">=0.10.0"；无 build、无运行时依赖
package.json               # 仅 devDependencies（typecheck）
index.server.ts
index.client.tsx
shared/schema.ts           # 策略 / Verdict / 卡片 zod schema
server/gate.ts             # 串行队列、状态机、dispatch/finalize/fix、恢复
server/git.ts              # toplevel、tree 快照
server/ledger.ts           # node:sqlite
server/prompts.ts
server/reviewer.ts         # 源 Agent / profile / 显式字段的分层解析
server/permissions.ts      # 托管 Agent 权限请求的自动批准 / 上交规则
scripts/create-agent-profiles.mjs  # 创建 reviewer/verifier agent profile（经 paseo CLI）
client/gate-card.tsx
server/gate.test.ts        # 真实 git + sqlite、fake paseo 的状态机测试（node:test，npm test）
```

`server/` 下的测试文件不会被入口 import，因此不会打进插件包。插件模块之间的 import 带 `.ts` 后缀：Paseo 的 esbuild 能解析，node 的 `--experimental-strip-types` 也能直接运行，不需要额外的测试依赖。

## 13. 验收标准

- [ ] 读取并校验 `.paseo/post-turn-gate.json`；无效时显示 ERROR 卡片，不创建子 Agent。
- [ ] `turn_started` 冻结策略和基线 tree。
- [ ] 支持 `done` 检查列表（review、verify，按顺序）；只处理 `completed` 且有改动的 turn。
- [ ] 默认只触发根 Agent，以及带 `post-turn-gate.target=true` 的子 Agent；`managed=true` 永远不触发。
- [ ] Reviewer 与源 Agent 在同一 workspace，以源 Agent 为 parent；默认继承 provider/model/mode/thinking/features，可用 agent profile 或显式字段覆盖。
- [ ] `scripts/create-agent-profiles.mjs` 能创建、更新 reviewer/verifier profile 并热加载。
- [ ] Reviewer 改动工作区时，卡片显示警告和 diffstat；解析失败 → ERROR；Reviewer 等待授权时，卡片显示“等待授权”，且不因此超时。
- [ ] 卡片按 `post-turn-gate:<run_id>` 原地更新；run 到终态后归档子 Agent，并且可以在“历史”页找到。
- [ ] `report` 只报告；`fix` 在源 Agent 空闲时发送 findings，修复后按原基线重新 review；轮次用尽 → NEEDS_HUMAN。
- [ ] 用户插话会让进行中的 run 变为 SUPERSEDED，不会打断用户的 turn。
- [ ] 同一个 source turn 只有一个 run；同一轮只创建一个子 Agent。
- [ ] 插件或 daemon 重启后，未终结的 run 能继续推进，或进入 ERROR。

## 14. 实施顺序

1. 骨架、`shared/schema.ts`、`server/git.ts`，以及单测。
2. 串行队列、`turn_started` 快照、`turn_ended` 过滤与 claim（`ledger.ts`）。
3. dispatch、finalize、卡片、归档（先跑通 report 模式）。
4. fix 循环、SUPERSEDED、轮次上限。
5. 恢复、对账、超时；在真实 kiro、codex、claude 上分别做端到端冒烟（补齐 §15 中的验证项）。

## 15. 待办与后续

- [ ] **TODO：真实 Paseo + codex 冒烟**：确认继承配置创建、`outputSchema` verdict、拒绝权限后继续，以及源 Agent 开启 Plan mode 时子 Agent 实际以 Plan off 运行。源码级适配与单测已完成。
- [ ] **TODO：实测 claude**：逐项对照 K3、K5、K6。

后续（不在 MVP）：

- 按 provider 提供可选的只读 mode 映射（§5）；
- 给 Paseo 提 PR 暴露 `server.paseo`，解决冷启动恢复；给 timeline renderer 增加 `navigation`，支持卡片跳转。
