# Turn outcome 分类与监督处理

当前只支持 v3。分类是决策前的低成本预筛，不是可配置的 `on_outcome` 动作表。证据和上游改进见 [paseo-pr-turn-outcome.md](paseo-pr-turn-outcome.md)。

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
- **S5**：Codex app-server 进程退出时，Paseo 上报 `Codex app-server exited …`；Codex 用量耗尽的 real-e2e 保护逻辑匹配 `hit your limit`。插件分别归类为 `crashed` 和 `quota_exhausted`，并用单测固定这些措辞。

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
| `crashed` | `failed`，文本匹配 `exited unexpectedly\|app-server exited\|SIGKILL\|SIGTERM\|spawn .* ENOENT` | Kiro 实测（E5）+ Codex 源码 |
| `context_exhausted` | `failed`，文本匹配 `context (limit\|window\|length)\|too many tokens\|maximum context\|start a new session` | 文本推断 |
| `quota_exhausted` | `failed`，文本匹配 `(daily\|monthly) (usage )?limit\|hit your (usage )?limit\|quota exceeded\|out of credits\|insufficient (credits\|balance\|quota)\|billing` | 文本推断（S4、S5） |
| `rate_limited` | `failed`，文本匹配 `too many requests\|throttl\|rate.?limit\|overloaded` | 文本推断（S4） |
| `network` | `failed`，文本匹配 `dispatch failure\|ECONN\|ETIMEDOUT\|ENOTFOUND\|EAI_AGAIN\|socket hang up\|network\|timed? ?out\|\b50[234]\b` | 实测（E6 的 `dispatch failure`）加推断 |
| `error` | 其余 `failed` | — |
| `awaiting_user` | `completed`，且通过两段式判定（§2.1） | 语义判定 |
| `done` | 其余 `completed` | 实测（E1） |

- **匹配文本** = `outcome.error.message` + 本轮所有以 `[System Error]` 开头的 `assistant_message`（S3），统一转小写。
- **`quota_exhausted` 放在 `rate_limited` 之前**：“quota exceeded, please wait” 这类措辞会同时命中两边，按不可重试处理更安全。
- 单独的 `429` 或 “try again later” 不足以证明是短期限流，按 `error` 交 decider，不机械重试。
- **正则只在插件内维护**，按 provider 分组，全部写成常量，配单测。发现新措辞时补表即可。`ponytail:` 这是基于文本的临时方案，上限见 §6。

## 3. 预筛与 decider

`stopSignal` 查看 assistant 文本，识别空回复、拒答、未闭合代码块、结束在 tool call、未完成 todo 和真实提问。已完成报告的单句客套结尾会被排除（如 “Let me know if you need anything else.”）；不会只凭正文中一个问号判断。命中是提示，decider 再做语义判断。无结构化 stopReason，漏判仍可能先检查半成品。

| 类别 | 当前处理 |
|---|---|
| `done`，有改动、没有问题或未完成信号 | 立即检查，跳过宽限期与计划；全部 PASS 直接完成，其他结果给 merge decider |
| `awaiting_user` / `refused`，做过工作或有改动 | 宽限期后 decider 出计划；推测性检查可并行 |
| `crashed` / `network` / `rate_limited` | 30s、2min、8min 机械重试，最多 `max_retries` 次，之后交 decider |
| `quota_exhausted` / `context_exhausted` | 直接找人，不重试、不启动 decider |
| `error` | decider 判断继续或找人 |
| `user_canceled` | 不启动 decider；保留未接受的改动等待用户下一条消息 |
| `replaced` | 新消息已接手，原 baseline 与需求继续保留 |
| completed 但无有效 assistant 回复（`missing_reply`） | 交 decider，不走完成捷径；即使未改动文件 |
| 纯聊天，有正常回复，无改动、无工具调用 | 不介入 |

PASS 捷径不依赖 `speculative_checks`，但非 PASS 的自动回复仍等待宽限期。权限被拒、需求歧义、角色改树、检查失败直接找人。INCONCLUSIVE 不代表完成。

## 4. 连续任务与控制

`tasks` 保存源 Agent 的 baseline、需求历史、决策轮、自动发送预算、重试时间、角色创建 payload、PASS tree 与卡片。`chain_children` 登记 decider。用户输入取消旧决策并追加约束，重置预算；自动回复或重试保持同一任务范围。carry 的原基线会覆盖下一轮未改文件的 turn，24 小时后过期。

回复为 `pts:<chain>:<n>`，前缀 `[post-turn gate answered on your behalf]`；重试为 `ptg:retry:<chain>:<n>`。每次发送检查持久化 source revision，并在 refresh 后复查 revision、idle/error 与待处理权限。hook 入队前即使旧自动化失效；发送 ack 丢失时用 messageId/clientMessageId 分页对账，未确认则暂停且不重发。Stop auto-answering 取消当前决策及检查；Resume 对下一轮生效。

停止插件回复发起的 turn 时，任务链和 Stop/Resume 按钮保留。卡片说“The turn was stopped.”，因为 Paseo 不能证明停止者是谁。停止永远不让 decider 推翻。

## 5. 局限

失败分类依赖错误文本，`replaced` 与 `user_canceled` 依赖结束时状态，存在竞态和误判；无法识别实际停止来源。Paseo 需要提供结构化 `stopReason`、`canceled.cause` 和错误类别。默认冷启动恢复需要首个事件；配置显式本地 SDK 地址可在无事件时启动恢复（[local-development.md](local-development.md)）。子 Agent 归档可见性与发送竞态见 [design.md](design.md)。
