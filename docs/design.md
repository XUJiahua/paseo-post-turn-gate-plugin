# Post-turn supervisor 实现设计

当前仅支持 v3 策略。插件的职责是独立检查，并由 decider 自动回复推动任务；没有 v2 模板修复、独立 answerer 或只报告模式。完整监督器提案和未实现部分见 [completion-supervisor.md](completion-supervisor.md)，场景见 [workflow.md](workflow.md)。

目标 Paseo >= 0.10.0；本机验证宿主为 0.10.1。启动配置不限制 provider id，三个角色继承源 Agent，也可以用 profile 或显式字段覆盖。`plan_mode` 按 feature 名强制关闭，对代理 provider 同样适用。

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
| C1 | `outputSchema` | Gate 的 verdict / decider schema 原样传给 Paseo；Codex provider 会规范化后传给 `turn/start` | Paseo Codex provider 源码与单测 |
| C2 | 源 Agent 开着 `plan_mode` | reviewer、verifier、decider 强制以 `plan_mode: false` 启动；其余 model、mode、thinking、Fast 设置照常继承 | 本插件单测；Paseo Plan 模式会在 turn 完成后产生计划确认请求 |
| C3 | Codex app-server 退出 | `Codex app-server exited …` 归类为 `crashed` | Paseo Codex transport 源码与本插件单测 |
| C4 | Codex 用量耗尽 | `You've hit your usage limit` 归类为 `quota_exhausted`，不会自动重试 | Paseo Codex real-e2e 的错误判定措辞与本插件单测 |

这些平台探针是历史证据；后续 kiro、codex-proxy 冒烟见 completion-supervisor.md §19.1。K13 使用的是旧协议消息 id，用于证明发送行为，不代表当前的修复流程。

## 2. 策略与角色

策略路径是 `<git toplevel>/.paseo/post-turn-gate.json`，唯一格式：

```json
{
  "version": 3,
  "trigger": "root_and_opt_in",
  "supervision": {
    "checks": ["verify", "review"],
    "speculative_checks": true,
    "reply_delay_seconds": 60,
    "budget": { "max_auto_sends": 12, "max_retries": 3, "max_no_progress_rounds": 2, "max_minutes": 120 }
  },
  "agents": { "decider": {}, "verifier": {}, "reviewer": {} }
}
```

`trigger` 为 `root_only`、`root_and_opt_in` 或 `all`。默认检查根 Agent 与带 `post-turn-gate.target=true` 的子 Agent。插件管理的 Agent（`post-turn-gate.managed=true`）和它们的后代始终排除，最多追溯 10 层。

每个角色的配置由源 Agent → 可选 profile → 显式字段覆盖。切换 provider 时清除上一层 provider 专属设置；profile 按 id、再按准确名称匹配。角色 prompt 始终由插件提供，profile 只负责启动设置。

`instructions_file` 默认 `.paseo/post-turn-gate/<role>.md`，默认文件可缺失；自定义路径必须存在。`realpath` 拒绝仓库外路径和符号链接。HTML 注释被剥离，文件规则加 inline `instructions` 最多 20,000 字符，在 turn 开始时冻结。不存在 `answerer.md` 回退。

`permissions` 默认 `auto`；checker 超时默认 30 分钟，decider 默认 10 分钟。`permission_wait_minutes` 默认 5。初始化命令输出全部默认字段，并保留已有规则文件。

## 3. 事件与任务范围

`server/supervisor.ts` 是 hooks、控制 RPC 和对账的统一入口；`server/gate.ts` 执行工作流。每个 workspace 一个串行队列，hook handler 只入队。基线在 `turn_started` 到达时立即拍摄，不等待队列。Git 调用限时 120 秒；无法拍基线时显示错误卡。

Task 是一个源 Agent 跨 turn 的需求和改动范围。用户追加消息保留原始 baseline，追加需求文本，取消旧检查和未发送的回复；自动消息同样追加上下文，但不视为用户接手。请求保留最多五条历史用户消息，长文本从中间裁剪，保留原始请求和最新约束。

纯聊天（无 tool call、无改动、无 carry）不启动决策。停止不是接受改动：用户发起的 turn 停止后写 carry；插件发起的 turn 停止后保留任务链与控制按钮。carry 24 小时过期。

## 4. 检查与决策

- 普通 `done` 且任务有改动：立即检查，不等宽限期，不出计划；全部 PASS 直接结束，无 decider、无消息。非 PASS 进入 merge，自动回复仍尊重宽限期。
- 提问或未完成：有改动且 `speculative_checks=true` 时立即启动检查；宽限期后 decider 出计划。无 worker 的计划可直接回复并取消检查；其余计划等待结果，再由另一个 decider 子 Agent 汇总。
- 当前共享目录中的 verify、review 按 `checks` 串行；第一个 FAIL 结束 run，INCONCLUSIVE 继续后续检查。CRITICAL/HIGH finding 无论模型写什么都强制 FAIL。
- decider 可以写答案、修复要求或继续指令。完成有改动的任务必须有当前 tree 的 PASS；FAIL 不能靠辩解被推翻。同 tree、无新用户需求时复用结果，用户接手后由新的决策重新判断检查需求。
- checker 或 decider 期间 tree 变化，结果作废并找人，不回滚。checker 失败、无效结果、被拒的必需权限、需求歧义也找人。其他 INCONCLUSIVE 给 decider 补齐证据；不是 PASS。
- 同题再问、`answerRisk`、总发送数、连续无进展、墙钟由代码约束。用户接手重置自动预算，保留 baseline。

两个 decider 阶段用两个子 Agent，因为 Paseo 的后续 `send()` 不能附 `outputSchema`。worker 永远看不到源 Agent 回复；decider 能看到，因而不提供独立验收证据。

## 5. 权限、发送与控制

`permissions.ts` 自动批准常规读文件、构建、测试和仓库内编辑；高风险命令、外部路径、凭据、对外操作上卡。prompt 要求角色不编辑，tree 对比负责发现违规。`ask` 模式把每个请求交给用户。请求无人回答超时后自动拒绝；checker 被追问一次已有证据下的结论，decider 失败则找人。

所有源 Agent 自动消息经过 `sendIfIdle`：refresh → 检查 idle/error → 同步 ledger 写入 → send，中间不 await。用户消息仍可能在竞态窗口被取消；当前没有原子条件发送或 outbox。

回复 id 为 `pts:<chain>:<n>`，机械重试为 `ptg:retry:<chain>:<n>`。Stop auto-answering 取消决策和检查，后续轮次找人；Resume 使下一轮重新自动处理。

## 6. 持久状态与恢复

SQLite 路径 `${PASEO_HOME:-~/.paseo}/plugin-data/post-turn-gate/ledger.sqlite`：

| 表 | 用途 |
|---|---|
| `tasks` | 每个源 Agent 一行：task_id、基线、需求、turn 快照、carry、任务链、决策轮、预算、PASS tree、重叠 Agent |
| `gate_runs` | 当前检查及 verdict，task_id 指回任务 |
| `gate_children` / `chain_children` | checker / decider 所属关系，包括迟到事件的识别 |
| `config_errors` | 每 Agent 的配置错误卡，配置恢复后标记 fixed |

不再保存修复次数、已失败 carry tree、旧 answerer 输入或反驳字段；不导入早期拆分的旧表。已有 SQLite 中多余的列不参与逻辑。无法通过当前 schema 的活动策略快照会被退休，不兼容 v2。

首个 hook/RPC 后立即对账，之后每 60 秒一次。DISPATCHING 重放精确 create payload（同 id/key），REVIEWING 或 decider idle 时从 timeline 恢复结果，运行超时则终止。宽限期和重试在 ledger 中保存截止时间，timer 及对账都能推进。无事件的冷启动无法立即恢复；已发送源消息目前没有完整 outbox 对账。

## 7. 卡片与验证

一个决策轮一张 outcome 卡，检查进度、权限和 decider 回复都写在这一张里；新轮关闭旧卡。配置和快照错误用独立 error 卡。子 Agent 运行时在 Subagents，归档后在 History；卡片提供 logs 命令。模型自由文本按请求语言输出，插件自身状态文字固定英文。

测试使用真实临时 Git 仓库、SQLite 和 fake Paseo，覆盖 PASS 捷径、FAIL 合并、任务范围、恢复、权限、取消、队列和 provider 配置。历史真实 kiro、codex-proxy 与带 target 标签的子 Agent 冒烟见监督器实现记录。Claude 暂未验证。

未实现：原子发送、结构化 revision/outbox、隔离 worker worktree、严格 workspace lease、完整进展指纹、独立 Pause/Replace。缺少这些能力不关闭已有自动化。
