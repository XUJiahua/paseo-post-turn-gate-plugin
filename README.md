# Paseo Post-turn Gate（v3）

让 Paseo 中的编码任务在一轮结束后继续接受检查和反馈。插件创建独立的 verifier、reviewer 检查需求与代码；需要继续、回答问题或修复时，decider 生成一条消息发回原 Agent。正常完成且检查全部 PASS 时直接结束，无需 decider。遇到需要用户决定的事项时，任务交回聊天窗口。

| 想了解什么 | 从哪里读 |
| --- | --- |
| 安装、启用、日常操作 | 本页 |
| 策略字段、角色规则、模型选择、启动恢复配置 | [配置指南](docs/configuration.md) |
| 哪些轮次触发检查，结果如何推动下一轮 | [工作流程](docs/workflow.md) |
| 事件、Git 快照、持久状态、发送和恢复机制 | [实现原理](docs/design.md) |
| 完成、停止、错误如何分类和处理 | [轮次结果处理](docs/turn-outcomes.md) |
| 本地开发与验证 | [开发测试](docs/local-development.md) |

## 1. 准备条件

- Paseo 至少 0.10.0；当前开发测试基线是 0.10.1。启用 Settings → Plugins，并能通过 `paseo` CLI 访问正在运行的 daemon。
- 目标目录是 Git 工作区，Git 在 daemon 运行环境中可用。
- 原 Agent 的 provider、模型和认证可正常工作。三个角色默认继承它的启动设置，会产生额外模型调用。
- 初始化命令需要 Node；开发与测试使用 Node 24。插件使用 Paseo 的 Node 运行环境和 `node:sqlite`。

插件在宿主机器上运行受信任代码；安装前审阅来源，或用 `--ref <tag-or-commit>` 固定版本。

## 2. 安装插件

```bash
paseo plugin install XUJiahua/paseo-post-turn-gate-plugin
paseo plugin ls post-turn-gate --json
```

确认插件状态为 `running`，记下输出中的 `path`，它是已安装插件的目录。已安装时可用 `paseo plugin update post-turn-gate` 更新。

## 3. 在目标仓库启用

替换下面的插件路径与目标仓库路径，使用已安装版本的初始化程序：

```bash
node '<installed-plugin-path>/bin/post-turn-gate-init.mjs' --dir '/path/to/target-repo'
```

初始化程序定位目标目录的 Git 根目录，写入以下四个文件：

| 文件 | 用途 |
| --- | --- |
| `.paseo/post-turn-gate.json` | v3 策略：触发范围、检查顺序、等待时间、预算与角色设置 |
| `.paseo/post-turn-gate/verifier.md` | 如何证明需求已实现，应该运行哪些检查 |
| `.paseo/post-turn-gate/reviewer.md` | 代码正确性、项目规范与阻塞问题 |
| `.paseo/post-turn-gate/decider.md` | 可从仓库确定的决策，以及需要交给用户的问题 |

按项目修改规则后，将四个文件提交到目标仓库。已存在的策略不会被覆盖；`--force` 只重新生成策略，已有角色规则始终保留。参数见[初始化命令](docs/configuration.md#初始化命令)。

最小可用策略如下；初始化程序会写出完整默认值：

```json
{
  "version": 3
}
```

默认监听根 Agent，以及带 `post-turn-gate.target=true` 标签的子 Agent；先 verify 再 review，串行执行。decider 等待 60 秒，总自动发送上限为 12 次。无需预先创建角色 profile。

策略和规则在新任务的 turn 开始时读取；运行中的任务链继续使用已保存的快照。先完成配置，再在目标仓库启动新任务。详细默认值和修改生效范围见[配置指南](docs/configuration.md)。

## 4. 日常使用

在 Paseo 中创建 cwd 位于目标仓库的 Agent，像平常一样发送编码需求，例如“修复分页边界，并补充回归测试”。不需要额外聊天命令。

| 原 Agent 的表现 | 插件会做什么 |
| --- | --- |
| 修改文件后正常结束，没有问题或未完成信号 | 立即检查；全部 PASS 后完成，不再发消息 |
| 做过工作后提问或提前停下 | 宽限期后由 decider 判断；需要时等待检查，再发送答案、修复要求或继续指令 |
| 检查发现 FAIL | decider 汇总修复问题；修复后重新检查，不能用辩解替代 PASS |
| 未改文件的正常完成，或有正常回复的纯聊天 | 不启动检查或自动代答 |
| completed 但没有有效回复 | 交给 decider 判断，不直接接受为完成 |
| 明确的崩溃、网络或限流错误 | 按预算退避重试；其他错误分支见[轮次结果处理](docs/turn-outcomes.md) |
| 产品取舍、权限不足、额度耗尽、无法确认消息交付等 | 在卡片中说明原因，交给用户 |

每个决策轮在原 Agent 时间线中显示一张卡片，包含检查进度、权限请求和回复。自动代答以 `[post-turn gate answered on your behalf]` 开头。角色运行时在 Subagents 中查看，归档后在 History 中查看；卡片中的 `paseo logs <id>` 可查看角色日志。

## 5. 接管和权限

- **发送新消息**：旧决策和未发送的回复失效，进行中的检查会取消。尚未接受的改动保留在任务范围内，下一轮继续检查整项任务。
- **停止原 Agent**：不会因此启动 decider。停止不等于接受已有改动，下一轮仍可能检查这些改动。
- **Stop auto-answering**：取消当前决策和检查，后续轮次交给用户，直到点击 **Resume auto-answering**。Resume 对后续 turn 生效。
- **权限卡片**：默认批准常规角色工具请求，高风险上卡；需要更严格控制时设 `agents.<role>.permissions` 为 `ask`。默认等待 5 分钟未回答会拒绝请求。
- **交付无法确认**：先检查聊天记录，再发消息接管或确认后 Resume。不确定消息已经消耗预算，插件不会重发，Resume 也不重放旧消息。

## 6. 使用时需要知道的边界

检查者与 decider 在 source 的工作目录运行。检查期间被检查文件发生变化会使结果作废并交给用户；插件不回滚修改。把生成物放入 `.gitignore`，避免测试输出被当作代码改动。不同任务推荐使用独立 worktree；source 已在专属 worktree 时无需再创建一份。

用户事件在入队前使旧自动化失效，发送前也复查 revision、状态和权限；但最后检查到宿主接收之间仍存在竞态，尚无原子条件发送保证。角色权限判断和只读指令也不构成文件系统沙箱。

重启后默认在首个 hook/RPC 启动恢复。需要没有 Agent 活动也主动恢复时，配置[可选启动连接](docs/configuration.md#可选启动恢复)，环境变量必须进入 daemon 进程。

## 7. 快速排查

| 现象 | 检查方式 |
| --- | --- |
| 没有触发检查 | 确认插件 running、cwd 在 Git 工作区、Git 根目录有策略、Agent 命中 trigger；正常无改动或纯聊天不会触发 |
| 新增配置未生效 | 确认配置先于任务开始；活动任务沿用快照，可在新 Agent 中启动新任务验证 |
| 配置错误卡 | 修正 JSON、字段、规则路径或 profile；无改动的 turn 不发布策略错误卡 |
| 工作区变化使检查失效 | 停止其他目录写入，检查生成物忽略规则；自行保留或恢复修改，再发送新消息 |
| 子 Agent 结束但流程未继续 | 查看角色日志与卡片；允许 reconcile 对账，不要手工重发不确定的源消息 |
| 重启后没有恢复 | 默认需首个事件；使用可选启动连接时检查插件连接日志 |

希望让编码 Agent 帮你安装并定制项目规则，可以使用[安装任务模板](docs/install-with-agent.md)。开发安装、回归测试和真实 daemon 冒烟见[开发测试](docs/local-development.md)。
