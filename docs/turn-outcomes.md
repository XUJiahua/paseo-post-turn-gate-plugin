# Turn outcome 分类与分场景策略（设计）

目标：`agent.turn_ended` 的原因很多（完成、提问、用户中断、被新消息打断、进程崩溃、网络、限流/配额、上下文耗尽）。插件先把每次结束归入一个**类别**，再按策略决定下一步。Gate（review/verify）只是其中一个动作。

本文基于 2026-09-29 在真实 kiro-cli 2.25.0（Paseo 0.10.1 测试 daemon）上的实测，与 [design.md](design.md) 配套。

## 1. 实测结果

方法：探针插件记录 `turn_started` / `turn_ended` / `permission_requested`；在 `turn_ended` 里再 `refresh()` 一次 Agent，同时记录本轮的 timeline 片段（最后一条 `user_message` 之后的内容）。

| # | 场景（如何制造） | `outcome` | 本轮 timeline 片段 | 结束时的快照 | 事件顺序 |
|---|---|---|---|---|---|
| E1 | 完成（"Reply with exactly: ALL DONE"） | `completed` | `assistant_message: "ALL DONE"` | `idle`，`attention: finished` | started → ended |
| E2 | 提问后停下（"先问我用哪种语言，然后等我回答"） | `completed` | `assistant_message: "Which programming language …?"` | `idle`，`attention: finished` | 与 E1 **完全一致** |
| E3 | 用户点停止（`sleep 25` 中途 `cancelAgent`） | `canceled`，reason `"Interrupted"` | `assistant_message`、`tool_call:canceled` | **`idle`** | started → ended |
| E4 | 被新消息打断（`sleep 25` 中途再 `send`） | `canceled`，reason `"Interrupted"` | 同 E3 | **`running`** | 新一轮的 `turn_started` **比** `turn_ended` **早 1ms 到达** |
| E5 | 进程崩溃（SIGKILL 杀掉 kiro-cli 及其子进程） | `failed`，message `ACP agent exited unexpectedly (null, SIGKILL)`，无 code | `tool_call:canceled`，以及一条 `assistant_message: "[System Error] ACP agent exited unexpectedly …"` | `status: error`，`lastError` 同 message | started → ended |
| E6 | 网络不可达（`HTTPS_PROXY=http://127.0.0.1:9`） | `failed`，message `"Internal error"`，code `"-32603"` | `assistant_message: "[System Error] Internal error … data=\"… An unknown error occurred: dispatch failure\""` | `status: error` | started → ended |
| E7 | 所有场景 | — | — | kiro 的 `lastUsage` 都是 `null` | — |

补充已知信息（源码，未实测）：

- **S1**：ACP 适配层把 `stopReason` 为 `max_tokens`、`max_turn_requests`、`refusal` 的轮次一律转成 `completed`（`acp-agent.ts:3148`）。插件**无法**发现 kiro 的截断或拒答。
- **S2**：等待授权、计划确认、选择题**不会结束 turn**，走的是 `permission_requested`，其 `kind` 为 `tool | plan | question | mode | other`（design.md K11 已实测 tool 类）。
- **S3**：`turn_failed.diagnostic` 不会传给插件。但 Paseo 会把错误细节写进一条 `[System Error] …` 的 `assistant_message`（E5、E6），**真正有用的文本在这里**，`outcome.error.message` 往往只是 `Internal error`。
- **S4**：kiro 限流/配额错误的措辞来自其公开 issue，未实测，推测也是以 `-32603` 的形式传过来：
  - `Too many requests, please wait before trying again.`
  - `Request quota exceeded. Please wait a moment and try again.`
  - `The request was throttled by the service`
  - `You've reached your daily usage limit…` / `…monthly limit…`
  - `Context limit exceeded unexpectedly. Please start a new session to continue.`

结论：

- **可靠区分**：`done`/提问（二者合并） vs 用户停止 vs 被打断 vs 失败。被打断与用户停止都是 `Interrupted`，但被打断时 `refresh()` 看到的状态是 `running`（E4），用户停止是 `idle`（E3）。
- **只能靠文本判断**：失败的具体原因（崩溃、网络、限流、配额、上下文），以及提问 vs 完成。
- **无法区分**：kiro 的截断和拒答（S1）。

## 2. 类别

分类函数是纯函数：`classify({ outcome, turnItems, statusAtEnd }) → { category, detail }`。按顺序匹配，命中即停：

| 类别 | 判定 | 置信度 |
|---|---|---|
| `replaced` | `canceled` 且 `statusAtEnd === "running"` | 实测（E4） |
| `user_canceled` | 其余 `canceled` | 实测（E3） |
| `crashed` | `failed`，文本匹配 `exited unexpectedly\|SIGKILL\|SIGTERM\|spawn .* ENOENT` | 实测（E5） |
| `context_exhausted` | `failed`，文本匹配 `context (limit\|window\|length)\|too many tokens\|maximum context\|start a new session` | 文本推断 |
| `quota_exhausted` | `failed`，文本匹配 `(daily\|monthly) (usage )?limit\|quota exceeded\|out of credits\|insufficient (credits\|balance\|quota)\|billing` | 文本推断（S4） |
| `rate_limited` | `failed`，文本匹配 `too many requests\|throttl\|rate.?limit\|\b429\b\|overloaded\|try again later` | 文本推断（S4） |
| `network` | `failed`，文本匹配 `dispatch failure\|ECONN\|ETIMEDOUT\|ENOTFOUND\|EAI_AGAIN\|socket hang up\|network\|timed? ?out\|\b50[234]\b` | 实测（E6 的 `dispatch failure`）加推断 |
| `error` | 其余 `failed` | — |
| `awaiting_user` | `completed`，且通过两段式判定（§2.1） | 语义判定 |
| `done` | 其余 `completed` | 实测（E1） |

- **匹配文本** = `outcome.error.message` + 本轮所有以 `[System Error]` 开头的 `assistant_message`（S3），统一转小写。
- **`quota_exhausted` 放在 `rate_limited` 之前**：“quota exceeded, please wait” 这类措辞会同时命中两边，按不可重试处理更安全。
- **正则只在插件内维护**，按 provider 分组，全部写成常量，配单测。发现新措辞时补表即可。`ponytail:` 这是基于文本的临时方案，上限见 §6。

### 2.1 “是否在等用户”的两段式判定

只看问号不够：“我先按 Python 写了，如果你想换语言请告诉我。”没有问号，却在等人；“为什么会这样？因为……”有问号，却已经完成。所以分两段：

1. **预筛（插件内，零成本，重召回）**：`completed` 轮次的最后一段 assistant 文本满足任一条件即可进入第二段：
   - 以 `?` 或 `？` 结尾；
   - 最后 300 字内出现 `should I|shall I|would you like|do you want|which (one|option)|let me know|please confirm|before I (proceed|continue)|waiting for|要不要|是否需要|需要我|请确认|请告诉我|你希望|选哪个`；
   - 以编号选项列表结尾（`1.`、`A)` 等两项以上）。

   预筛不命中就是 `done`，照常走 gate，行为与现在一致。
2. **语义判定（post-turn Agent，只在预筛命中时运行）**：由它判断是否真的在等用户，并在能回答时直接给出答案（§3.1）。输出：

   ```json
   {"state": "awaiting_user | done | incomplete",
    "question": "...", "decision": "answer | escalate",
    "answer": "...", "reason": "..."}
   ```

   - `done`：退回 `done`，照常走 gate；
   - `incomplete`：Agent 没问问题，但也没做完（例如“接下来我会……”就停了）→ 按 `answer` 处理，回复 “Continue.”；
   - `awaiting_user`：按 `on_outcome.awaiting_user` 的动作处理。

判定和回答放在同一次调用里完成，预筛命中时只多花一次模型调用。解析失败按 `escalate` 处理，绝不自动回答。

## 3. 策略

策略文件新增 `on_outcome`，把类别映射到动作。未写的类别使用默认值：

```json
{
  "version": 1,
  "action": "review",
  "on_outcome": {
    "awaiting_user": { "answer": { "max": 3, "instructions": "Prefer the simplest option; never approve deleting data." } },
    "network": { "retry": { "max": 2, "delay_seconds": 30, "message": "The connection dropped. Continue from where you left off." } },
    "rate_limited": { "retry": { "max": 1, "delay_seconds": 120 } }
  }
}
```

动作：

| 动作 | 含义 |
|---|---|
| `gate` | 执行 `action`（review/verify）：现有逻辑，仍然要求工作区有改动 |
| `notify` | 在原 Agent 的 timeline 写一张“结束原因”卡片：类别、错误摘要、建议的下一步 |
| `ignore` | 只记日志 |
| `{ "retry": { "max": 1-3, "delay_seconds": 5-3600, "message"? } }` | 延迟后向原 Agent 发一条“继续”消息；超过次数后按 `notify` 处理。`message` 默认为 `Continue from where you left off.` |
| `{ "answer": { "max": 1-10, "instructions"?, "profile"? } }` | 由 post-turn Agent 代替用户回答（§3.1）；超过次数或它选择 `escalate` 时按 `notify` 处理。只对 `awaiting_user` 有效 |

默认值（保守，不做任何自动重试）：

| 类别 | 默认 | 可配置为 retry | 卡片上的建议 |
|---|---|---|---|
| `done` | `gate` | 否 | — |
| `awaiting_user` | `answer`，`max: 3` | 否（用 `answer`） | 放弃代答时：“Agent 在等你回答：<question>（原因：<reason>）” |
| `user_canceled`、`replaced` | `ignore` | 否 | — |
| `crashed` | `notify` | 是 | “Agent 进程退出。可以发消息让它继续，Paseo 会重新拉起会话。” |
| `network` | `notify` | 是 | “网络错误，可稍后重试。” |
| `rate_limited` | `notify` | 是 | “被限流，稍等后重试。” |
| `quota_exhausted` | `notify` | **否**（schema 拒绝） | “额度用尽，需要充值或换 provider。” |
| `context_exhausted` | `notify` | **否** | “上下文耗尽，需要新开会话或压缩上下文。” |
| `error` | `notify` | 否 | 附上错误原文 |

几点说明：

- `awaiting_user` 默认由 post-turn Agent 代答；此时不做 review（还太早，E2）。代答后的那一轮完成时，照常触发 gate，基线沿用见 §4。
- `on_outcome` 与 `trigger` 是正交的：只有被 `trigger` 选中的 Agent 才会分类和执行动作；`managed` 子 Agent 永远跳过。
- 策略文件为空时，行为与当前版本完全一致（`done → gate`，其余跳过），差别只是失败类会多一张 notify 卡片。

### 3.1 代答（answer）

post-turn Agent 与 Reviewer 的创建方式相同：同一 workspace、以源 Agent 为 parent、`managed` 标签、配置按 design.md §3.1 分层解析。默认 profile 为 `post-turn-gate-answerer`，由 `npm run profiles -- --role answerer` 创建。

prompt 包含：

- 原始需求（任务链起点的 `user_message`）；
- 仓库根目录与当前 diff 范围（`git diff <base> <end>`），可以自行查看代码；
- 源 Agent 最后一段回复全文；
- 策略里的 `instructions`；
- 约束：只根据需求、仓库内容和常识作答，回答要短、可执行。

必须 **escalate**、不得代答的情况（写进 prompt，并由插件二次检查）：

- 需求本身没有给出依据的产品或业务取舍（“要 A 还是 B”，且两者都合理）；
- 涉及删除数据、force push、发布或部署、花钱、改权限、凭据或密钥、对外发送消息；
- Agent 在索要只有用户知道的信息（账号、路径偏好、密码等）；
- 同一个问题已经代答过一次，Agent 仍然在问（死循环保护：问题文本相似度高于阈值即 escalate）。

代答的发送：与 fix 轮一致，源 Agent 必须是 `idle`；messageId 为 `ptg:answer:<chainId>:<n>`，消息开头注明 “[post-turn gate answered on your behalf]”，用户在 timeline 里能分清是谁回答的。卡片显示问题、答案、剩余次数，以及一个 “Stop auto-answering” 按钮（写入 carry，本链后续不再代答）。

## 4. 重试与基线

问题：一轮因网络失败而中断，重试后的那一轮才真正完成。此时 gate 应该 review **从最初那一轮开始的全部改动**，而不是只看重试那一轮。

做法：引入“任务链”（chain）。

- 原始轮次在 `turn_started` 时生成 `pending { policy, baseTree }`（现有逻辑）。
- 如果以 `retry` 或 `awaiting_user` 结束，就不丢弃 pending，改为保存为 `carry[agentId] = pending`，并记下 `attempts`。
- 下一轮 `turn_started` 时，若存在 `carry`，就沿用其中的 `policy` 和 `baseTree`，不再重新读取。用户在提问后回答，或者插件发出的重试消息，都属于这条链。
- 链在以下情况结束：
  - 出现 `done`：执行 gate，base 用链起点；
  - 出现 `user_canceled`：丢弃 carry；
  - 超过重试次数：notify；
  - carry 存在超过 24 小时：丢弃。
- 重试消息的 `messageId` 为 `ptg:retry:<chainId>:<n>`，与 fix 轮一样归入同一条链。发送前必须确认 Agent 为 `idle`，否则放弃重试（用户已经接手）。
- **存储**：carry 和待执行的重试写进 ledger 新表 `chains (agent_id PK, chain_id, policy_json, base_tree, attempts, next_retry_at, updated_at)`。对账循环（60s）负责到点发送，插件重启后也能继续。

`ponytail:` 等待用户回答期间，`awaiting_user` 会让 carry 一直保留，直到 24 小时过期。期间用户开始一个新任务，也会被算进同一条链，review 范围因此变大。可以接受：这只会多 review，不会漏。

## 5. 卡片

新增一种 kind：`post-turn-gate-outcome` v1，id 为 `post-turn-gate:outcome:<agentId>:<turnKey>`：

```ts
data = { category, message, suggestion, attempt, maxAttempts, nextRetryAt }
```

同一轮只写一张；重试进行中原地更新（例如“2 分钟后自动重试（1/2）”）。

## 6. 局限与上游改进

- kiro 的截断和拒答（S1）只能靠上游修复。
- 失败原因靠文本匹配：provider 改了措辞就会退化为 `error`。退化的结果只是 notify，不会误触发重试。
- **建议给 Paseo 提 PR**，在 `PluginTurnOutcome` 中增加：
  - `completed.stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal"`；
  - `failed.error.category?: "network" | "rate_limited" | "quota_exhausted" | "context_exhausted" | "crashed"`，由 provider 适配层统一归类；
  - `failed.error.diagnostic`；
  - `canceled.cause?: "user" | "replaced" | "closed"`。

  上游提供后，分类函数优先读结构化字段，文本匹配只作兜底。

## 7. 实施拆分

1. `server/outcome.ts`：`classify()` 与正则表；单测覆盖 E1–E6 的真实 payload，以及 S4 的措辞。
2. `shared/schema.ts`：`on_outcome` schema。`quota_exhausted` 和 `context_exhausted` 禁止配置 retry。
3. `gate.ts`：`handleTurnEnded` 先分类再分派；notify 卡片；`turn_ended` 时补一次 `refresh()` 取 `statusAtEnd`（gate 路径原本就会 refresh，可以复用）。
4. 链与重试：`chains` 表、carry 沿用基线、对账循环中的定时发送。
5. 代答：预筛 + post-turn Agent（判定与回答合一）、escalate 规则、死循环保护、`--role answerer` profile。
6. 端到端：用 kiro 复现 E2–E6，确认卡片、代答与重试；E6 可以在重试前撤掉代理，验证“重试后完成 → gate 使用原始基线”。

## 8. 已确认的决定（2026-09-29）

- `awaiting_user` 默认由 post-turn Agent 代答（§3.1），不能代答时 escalate 给用户。
- “是否在等用户”用两段式判定：规则预筛加语义判定（§2.1），不只看问号。
- 重试文本有默认值，可以在策略里用 `retry.message` 覆盖；代答可以用 `answer.instructions` 补充规则。

## 9. 附：Reviewer 权限请求卡住（2026-09-29 线上问题）

- **现象**：卡片显示 “Waiting for permission”，但无法操作。Reviewer 第一条 `git diff --stat` 在 `kiro_default` 模式下需要授权；卡片上没有按钮，Reviewer 又在源 Agent 的 Subagents 里，用户不容易找到。之后用户发了新消息，run 变为 `SUPERSEDED`，Reviewer 被归档。
- **修复**：卡片直接显示待处理的请求（标题、命令或路径），并按 provider 给出的 actions 渲染按钮（kiro 为 Yes / Always / No），点击后调用 `respondToPermission` 回答 Reviewer。Timeline renderer 运行在插件的 `PaseoApiProvider` 之下，可以使用 `usePaseo()`（源码 `app/src/plugins/timeline/view.tsx`）。拒绝会结束 kiro 这一轮（K6），卡片上有提示。运行中的卡片不再显示 “open it from History”，改为指向 Subagents。
- **降低打扰**：reviewer / answerer profile 可以开启 `auto_accept`（`npm run profiles -- --feature auto_accept=true`），前提是接受 Reviewer 自动执行命令。命令行下也可以用 `paseo permit ls` / `paseo permit allow <agent>` 回答。
