# v3 实现原理

[使用入口](../README.md) · [配置指南](configuration.md) · [工作流程](workflow.md)

本文描述当前代码如何执行，不定义额外的宿主 API 或未来协议。业务分支见[工作流程](workflow.md)，错误分类见[轮次结果处理](turn-outcomes.md)。

## 入口与代码地图

| 模块 | 负责什么 |
| --- | --- |
| [index.server.ts](../index.server.ts) | 创建 ledger/supervisor，注册 turn、权限 hooks 和 Stop/Resume RPC，卸载时清理 |
| [server/supervisor.ts](../server/supervisor.ts) | hooks、控制与 reconcile 的统一入口，维护周期对账和最新 SDK handle |
| [server/gate.ts](../server/gate.ts) | workspace 队列、任务范围、检查与决策轮、卡片、权限和恢复 |
| [shared/schema.ts](../shared/schema.ts) | v3 策略、verdict、计划/回复、卡片和 RPC 契约 |
| [server/git.ts](../server/git.ts) | 找 Git 根目录、生成工作区 tree 和 diffstat |
| [server/reviewer.ts](../server/reviewer.ts) | 角色启动设置的继承、profile 解析与 plan_mode 处理 |
| [server/prompts.ts](../server/prompts.ts) | 构建独立检查/决策 prompt，解析结构化结果 |
| [server/decisions.ts](../server/decisions.ts) | 根据检查结果决定下一检查、FAIL、PASS 或人工处理 |
| [server/outcome.ts](../server/outcome.ts) | 分类 source turn，预筛空回复、提问与未完成信号 |
| [server/permissions.ts](../server/permissions.ts) | 角色权限请求和自动回复的风险判断 |
| [server/dispatch.ts](../server/dispatch.ts) / [server/delivery.ts](../server/delivery.ts) | source 消息发送前防护及 timeline 接收证据查找 |
| [server/ledger.ts](../server/ledger.ts) / [server/startup.ts](../server/startup.ts) | SQLite 状态与可选本地启动连接 |
| [index.client.tsx](../index.client.tsx)、client/ | timeline 卡片、权限操作及 Stop/Resume 按钮 |

## 事件与并发

Paseo 的 lifecycle handler 可能交叠执行。插件 hook 迅速入队，不在 hook 中等待整个工作流；每个 workspace 有自己的串行队列，不同 workspace 并行处理。

源 Agent 的 turn_started、canceled 和 Stop 控制在入队前同步更新持久化 source revision。队列正在 await SDK/Git 时到达的用户事件，也能立即使旧决策失效。决策、重试和发送使用保存的 revision 复查有效性。

新任务的 baseline 快照在 turn_started 到达时就启动，不等待队列轮到它。快照读取仍是异步 Git 操作，不是和 source 写文件共用的原子锁。Git 调用有 120 秒超时；失败时显示快照错误，不能用未知 baseline 验收。

每个检查 run 的 verify/review 串行，但推测性检查可以与 decider 重叠。workspace 队列仅串行插件事件处理，不会锁住用户的 source turn 或另一 workspace 的进程。不同 workspace 使用同一目录时仍可能混入修改；重叠检测依赖插件观察到的 turn，不能完整发现插件启动前已运行的 Agent。

## 任务、快照与检查对象

| 概念 | 当前表示与含义 |
| --- | --- |
| turn | source 的一轮执行，用 hook、turnId 与 user message 关联 |
| task | 每个 source 的持续需求与改动范围，持久状态保存在 tasks |
| chain | 自动代答、机械重试和决策轮共享的任务链、策略快照与预算 |
| decision round | 一次 turn 结束后的决策，包含计划、检查与汇总；普通完成可跳过计划 |
| check run | 按 checks 顺序运行的独立验收，记录每项 verdict 和对应 tree |
| baseline / endTree | 任务起始工作区 tree / 本轮结束时的工作区 tree |
| source revision | 插件收到新 turn、取消或 Stop 后递增的本地版本，用于拒绝旧自动化 |

Git 快照用临时 index 执行 add -A / write-tree，包含 tracked、untracked 文件，排除 ignored 文件；不修改真实 index 或工作区。检查比较 baseline 到 endTree，而非只比较本轮 HEAD diff；任务开始前已有的修改会包含在 baseline 中，不属于本次任务新增改动。

角色通过 prompt 读取该范围的需求和代码，运行目录仍是 source 目录。checker 结束时比较当前 tree 与 endTree；decider 结束时比较它启动时的 tree。覆盖的文件发生变化时结果作废，不回滚。ignored 文件、仓库外文件或修改后恢复到相同内容的副作用，不能靠 tree 对比全部发现。

用户追加消息取消旧工作，但保留原始 baseline 和未接受的改动。请求文本累积原需求、用户补充及代答；初始上下文最多取五条历史用户消息，总长度限制为 8,000 字符，长文本从中间裁剪，保留开头与最新约束。它不是完整会话重放或结构化需求版本。

停止用户 turn 后的改动以 carry 保留；停止插件发起的 turn 则保留任务链和控制按钮。carry、任务链和保存的旧 turn 快照有 24 小时有效期；不能把 ledger 文件仍存在理解为任务范围永久有效。

## 角色创建与结果契约

插件创建角色前，先登记 child 所属关系和精确创建 payload，再调用同一 workspace 的 agents.create。角色以 source 为 parent，带 managed/role 标签；迟到事件不会被当作新的 source 任务。恢复重放使用原 agentId、idempotencyKey 和 payload，不生成新 key 去重试同一创建。

每次角色创建根据 source → profile → 显式字段解析启动设置。角色 prompt 始终由插件构建：内置职责与 JSON 契约，再追加任务开始时冻结的仓库规则。Paseo outputSchema 用于支持结构化输出的 provider；不支持时依赖 prompt 和本地 JSON/schema 校验。无法解析的结果不能视作 PASS。

checker 输出 verdict、summary、findings 和 inconclusive_reason；CRITICAL/HIGH finding 强制 FAIL。decider 的计划包含 assessment、workers、reply_now、question，汇总包含 send/done/escalate。两个阶段用两个子 Agent。完整分支、有效 PASS 复用和 FAIL 约束见[工作流程](workflow.md#检查结果如何生效)。

## 权限与控制边界

插件只处理宿主实际上报的角色权限请求。auto 模式用路径检查、命令解析和模式匹配批准常规请求，高风险上卡；ask 全部上卡。provider 自身的自动许可设置与沙箱仍然决定哪些请求会上报，插件不能拦截所有未上报动作。

权限等待计入角色超时。超时拒绝后 checker 可能收到一次追问，给已有证据下的 verdict；若需要的权限不足以验收，则交给用户。部分权限等待状态在内存中，重载后恢复显示的请求可能重新计时，不保证原始等待时长精确连续。

产品取舍、扩大范围等交由 decider 的指令约束；风险回复还经过代码检查。命令/自然语言匹配并非完整安全证明，角色的只读 prompt 和 Git tree 检查也不构成沙箱。

## 持久状态

SQLite 位于 `${PASEO_HOME:-~/.paseo}/plugin-data/post-turn-gate/ledger.sqlite`，属于 daemon 的本地状态，策略和规则则属于目标 Git 仓库。

| 表 | 用途 |
| --- | --- |
| tasks | task_id、baseline、请求、turn 快照、carry、chain、decision round、预算、PASS tree、卡片与重叠信息 |
| gate_runs | 检查 run、顺序位置、verdict、结果、超时与创建 payload |
| gate_children / chain_children | checker / decider 所属关系，识别迟到事件 |
| source_revisions | source 本地版本，独立于 task 清理，避免版本回到初值 |
| source_dispatches | 源消息 ID、文本、pending/accepted/unknown/superseded 状态及错误 |
| config_errors | 每个 source 的配置错误卡与配置 hash |

不是所有内存信息都持久化：workspace 队列、活动 Agent 跟踪和部分权限等待状态需要在后续事件或对账中重新建立。

## 发送与交付确认

所有发给 source 的自动回复和机械重试经过同一个 sendIfIdle 入口：

1. 检查 round/retry 的 revision 仍有效。
2. refresh source，再检查 revision、idle/error 及无 pendingPermissions。
3. 同步写 pending 发送意图，并更新预算/决策状态。
4. 不插入 await，立即调用 send(text, messageId)。
5. ack 成功标记 accepted；异常保留 unknown，查找 timeline 接收证据。

回复 ID 为 `pts:<chain>:<n>`，重试为 `ptg:retry:<chain>:<n>`。同 messageId 的重复本地意图会被唯一约束拒绝；这不是宿主级幂等保证。

timeline 对账只把匹配 user_message 的 messageId/clientMessageId 当作正向证据，最多读取 10 页、每页 500 条。gap、epoch 改变、重复 cursor 或到达边界时保留未知；找不到不证明未发送。

无法确认时暂停自动回答、清除待执行时间并出卡。发送已消耗预算，不重发也不退回预算。新 source turn 或明确 Resume 会使旧未确认记录失效；Resume 不重放旧消息。source revision 只反映插件已收到的事件，最后检查到宿主接收之间仍存在用户消息竞态。

## 恢复与当前保证

首个 hook/RPC 提供 SDK 后立即 reconcile，之后每 60 秒一次；定时器也推进宽限期和到期重试。配置[启动连接](configuration.md#可选启动恢复)后，本地 SDK 可以在没有 Agent 事件时触发同一入口。

reconcile 读取 ledger 与宿主当前状态：重放未完成的角色创建、从已结束角色 timeline 取回结果、处理超时、到期决策/重试及未知源消息。checker 结果恢复读取尾部 500 条，decider 读取尾部 200 条，尚未统一为完整历史扫描；缺少历史 outcome 时按当前状态推断，不恢复 provider 丢失的 stopReason。活动策略快照无法通过当前 schema 时停止相应恢复工作。

| 能力 | 当前保证 | 使用上的影响 |
| --- | --- | --- |
| 用户事件使旧工作失效 | 本地持久化 revision，入队前立即更新 | 已观察的用户接管可阻止旧发送；最终宿主竞态仍在 |
| 源消息异常恢复 | 持久化证据、正向对账、未知时暂停 | 避免盲目重发，但可能需要人工确认；没有 exactly-once |
| 无事件启动 | 显式 loopback SDK 连接可选 | 需配置 daemon 环境；默认仍等待首个事件 |
| 检查独立性 | 不给 checker source 回复，检查目录前后 tree | 共享目录、不是隔离快照，不锁外部写入 |
| outcome 分类 | 粗粒度宿主结果加文本启发式 | 无法可靠识别所有截断、拒答或取消来源 |

当前宿主契约限制统一跟踪在 [issue #2](https://github.com/XUJiahua/paseo-post-turn-gate-plugin/issues/2)。这些限制不影响已有 v3 自动化入口，但决定其保证范围。
