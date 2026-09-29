# 工作流程（按场景）

下面每个场景都是一次真实会发生的对话：你对 agent 说了什么，插件在背后做了什么，时间线上出现什么卡片。实现细节见 [design.md](design.md) 和 [turn-outcomes.md](turn-outcomes.md)。

示例仓库的策略文件 `.paseo/post-turn-gate.json`（用 `npm run init` 生成全部默认值后改了这几项，下面只列出改过的）：

```json
{
  "version": 2,
  "on_fail": { "fix": { "max_rounds": 2 } },
  "on_outcome": {
    "awaiting_user": { "answer": { "max": 3 } },
    "network": { "retry": { "max": 2, "delay_seconds": 30 } }
  }
}
```

## 先看全貌：一轮结束后插件怎么决定

```mermaid
flowchart TD
  A[你给 agent 发消息，agent 开始干活] --> B[插件记下工作区快照 baseTree]
  B --> C[agent 这一轮结束]
  C --> C1{"你没点停止，而且<br/>这个任务改了文件？"}
  C1 -- 没改文件 --> N[什么都不做<br/>纯问答不派任何 agent]
  C1 -- 改了 --> D{这一轮是怎么结束的？}
  D -- 做完了 --> R[派 reviewer 审查改动<br/>或 verifier 核对需求]
  D -- 停下来问你 / 没说完 --> Q[派 answerer 判断能不能替你回答]
  D -- 网络错误 / 限流 --> T[按配置稍后自动重试]
  D -- 额度用完 / 上下文满 / 崩溃 --> X[只发一张说明卡片]
  D -- 你点了停止 --> S[结束，不打扰你]
  R --> V{结论}
  V -- PASS --> P[卡片：PASS]
  V -- FAIL --> F[把问题发回 agent 修，修完再审]
  Q -- 能安全回答 --> AQ[替你回复，agent 继续]
  Q -- 需要你决定 --> U[卡片：需要你回答]
```

## 场景 1：改完代码，审查通过

你说："阅读代码，使用 mermaid 整理这个插件的工作流程。" agent 新建了 `docs/workflow.md`，并在 README 加了链接。

```mermaid
sequenceDiagram
  actor 你
  participant A as 开发 agent
  participant G as 插件
  participant R as reviewer（子 agent）

  你->>A: 用 mermaid 整理工作流程
  G->>G: 快照 baseTree
  A->>A: 读代码，写 docs/workflow.md
  A-->>G: 这一轮完成
  G->>G: 快照 endTree，与 baseTree 不同 → 需要审查
  G->>R: 创建 reviewer："审查 git diff baseTree endTree"
  G-->>你: 卡片 Review · REVIEWING
  R->>R: 读 diff，对照源码核实图里的说法
  R-->>G: {"verdict":"PASS","summary":"只改了文档……"}
  G->>R: 归档（History 里还能打开）
  G-->>你: 卡片 Review · PASS，+2 non-blocking findings
```

MEDIUM / LOW 级别的问题只显示为 "non-blocking findings"，不会拦住你。

## 场景 2：审查不通过，自动修复

你说："给 /users 接口加分页。" agent 加了 `limit` / `offset`，但没校验负数。

```mermaid
sequenceDiagram
  actor 你
  participant A as 开发 agent
  participant G as 插件
  participant R1 as reviewer #1
  participant R2 as reviewer #2

  你->>A: 给 /users 加分页
  A-->>G: 完成，改了 3 个文件
  G->>R1: 审查
  R1-->>G: FAIL · [HIGH] offset 为负数时 SQL 报错
  G-->>你: 卡片 FIXING（第 1/2 轮）
  G->>A: "审查没通过……修复 CRITICAL 和 HIGH 问题后停下"
  A-->>G: 修好了，补了测试
  G->>R2: 重新审查（仍从最初的 baseTree 算起）
  R2-->>G: PASS
  G-->>你: 卡片 PASS
```

- 自动修复是默认行为（`max_rounds: 2`），目的是让 agent 自己循环到通过。设为 `"on_fail": "report"`（或 `npm run init -- --report`）时只出 FAILED 卡片，不发回去修。
- 修了 `max_rounds` 轮还是 FAIL，卡片变成 NEEDS_HUMAN，交给你处理。
- 修复期间你自己发了消息，这次审查标为 SUPERSEDED，以你的消息为准。

每个仓库的审查规则可以写在 `.paseo/post-turn-gate/reviewer.md` 里（`npm run init` 会生成带示例的模版，示例在 HTML 注释里，不会生效），和代码一起提交，例如"金额一律用整数分"、"新接口必须有集成测试"。reviewer 会把它当作额外规则。verifier、answerer 分别对应 `verifier.md`、`answerer.md`。

## 场景 2b：按需求逐项核对（verify）

你说："给 /users 加分页：支持 limit 和 offset，limit 最大 100，返回 total。" 这类请求是一张需求清单，比起代码风格，你更关心每一条是否都做到了。策略里写 `"on_outcome": { "done": ["verify"] }`（或 `npm run init -- --check verify`）。

```mermaid
sequenceDiagram
  actor 你
  participant A as 开发 agent
  participant G as 插件
  participant V as verifier（子 agent）

  你->>A: 分页：limit/offset，limit ≤ 100，返回 total
  A-->>G: 完成
  G->>V: "改动是否完整实现了原始请求？"
  V->>V: 把每条需求对应到改动，跑构建和测试
  V-->>G: FAIL · [HIGH] 没有返回 total
  G-->>你: 卡片 Verify · FAILED（或按 on_fail 发回修复）
```

verifier 和 reviewer 的区别只在于问的问题：reviewer 问"代码对不对、好不好维护"，verifier 问"要的东西是不是都有了"。verifier 用 `agents.verifier` 的配置，默认 profile 是 `post-turn-gate-verifier`；这个 profile 还没建时继承开发 agent 的配置，卡片上会提示。

## 场景 2c：先核对需求，再审代码

同一个分页需求，你既想确认需求都做到了，也想让人看看代码质量。策略里写 `"on_outcome": { "done": ["verify", "review"] }`（或 `npm run init -- --check verify,review`），`on_fail` 保持默认的 `{ "fix": { "max_rounds": 2 } }`。

```mermaid
sequenceDiagram
  actor 你
  participant A as 开发 agent
  participant G as 插件
  participant V as verifier
  participant R as reviewer

  A-->>G: 完成
  G->>V: 第 1 轮 · 核对需求
  V-->>G: FAIL · [HIGH] 没有返回 total
  Note over G,R: verify 失败，本轮不再审代码
  G->>A: 修复 total 的问题
  A-->>G: 修好了
  G->>V: 第 2 轮 · 重新从 verify 开始
  V-->>G: PASS
  G->>R: 第 2 轮 · 审代码
  R-->>G: PASS
  G-->>你: 卡片 Verify → Review · PASS，每项一行
```

- 按列表顺序执行，第一个 FAIL 就停：需求没做到时审代码意义不大，修复时代码还会改。
- 修复后从第一项重新检查，因为修复可能破坏已经通过的检查。
- 两项都 PASS 才算 PASS；某项 INCONCLUSIVE 时后面照常检查，最终结果为 INCONCLUSIVE。
- 不并行执行：两个 agent 在同一个工作区里同时构建、测试会互相干扰。

## 场景 3：agent 问了一个仓库能回答的问题

你说："给 outcome.ts 补测试。" agent 回复："测试用 vitest 还是 node:test？" 然后停下了。

```mermaid
sequenceDiagram
  actor 你
  participant A as 开发 agent
  participant G as 插件
  participant Q as answerer（子 agent）
  participant R as reviewer

  A-->>G: 这一轮结束，回复以问号结尾
  G->>G: 预筛：像在提问 → awaiting_user
  G->>Q: "agent 在等用户吗？能替用户回答吗？"
  G-->>你: 卡片 answering（有 Stop auto-answering 按钮）
  Q->>Q: 看到 package.json 用的是 node --test
  Q-->>G: {"state":"awaiting_user","decision":"answer","answer":"用 node:test，和现有测试保持一致"}
  G->>A: [post-turn gate answered on your behalf]<br/>用 node:test，和现有测试保持一致
  G-->>你: 卡片 answered（第 1/3 次）
  A-->>G: 测试写完
  G->>R: 审查整个任务的改动（从你第一条消息开始）
  R-->>G: PASS
```

这几轮属于同一个任务（chain），所以审查的是整个任务的累计改动，不是最后一轮。

## 场景 4：问题必须由你决定

agent 问："旧的 users_v1 表要不要直接删掉？" 或者 "要我 push 到 origin 吗？"

```mermaid
sequenceDiagram
  actor 你
  participant A as 开发 agent
  participant G as 插件
  participant Q as answerer

  A-->>G: 停下来提问
  G->>Q: 能替用户回答吗？
  Q-->>G: decision = escalate（涉及删除数据）
  G-->>你: 卡片 needs_user："旧表要不要删？"
  你->>A: 先保留，加个迁移脚本
  G-->>你: 卡片改为 resolved："You replied; the task continues"
```

即使 answerer 给出了答案，插件也会再用关键词检查一遍（删除、push、部署、付费、密码等），命中就改为交给你。以下情况也会交给你：

- 同一个问题问了第二次；
- 自动回答次数达到 `max`；
- 你点了 Stop auto-answering；
- answerer 超过 `agents.answerer.timeout_minutes`（默认 10 分钟）没回复。

## 场景 5：agent 话没说完就停了

agent 执行完一条命令后这一轮就结束了，没有总结；或者 todo 列表还有没勾掉的项。

```mermaid
sequenceDiagram
  participant A as 开发 agent
  participant G as 插件
  participant Q as answerer

  A-->>G: 这一轮最后一步是工具调用
  G->>G: 预筛：tool_last → awaiting_user
  G->>Q: 判断
  Q-->>G: state = incomplete
  G->>A: [post-turn gate answered on your behalf]<br/>Continue.
  A-->>G: 继续做完
```

如果 answerer 判断其实已经做完（`done`），插件直接开始审查。

## 场景 6：网络断了，自动重试

agent 正在工作时报错 `ECONNRESET`。

```mermaid
sequenceDiagram
  actor 你
  participant A as 开发 agent
  participant G as 插件

  A-->>G: 这一轮失败：ECONNRESET
  G->>G: 归类为 network，配置允许重试 2 次
  G-->>你: 卡片 retry_scheduled：30 秒后重试（1/2）
  Note over G: 30 秒后
  G->>A: Continue from where you left off.
  G-->>你: 卡片 retrying
  A-->>G: 这次完成了
  G->>G: 审查整个任务
```

- 30 秒内你自己发了消息，自动重试就取消，卡片显示 "You replied first"。
- 重试次数用完后只发通知卡片。
- 额度用完（`quota_exhausted`）和上下文满（`context_exhausted`）不允许配置重试，因为重试也不会成功，只会出一张说明卡片告诉你怎么处理。

## 场景 7：reviewer 需要执行命令

reviewer 在审查时想运行 `npm test`，后来又想运行 `git push`。

```mermaid
sequenceDiagram
  actor 你
  participant R as reviewer
  participant G as 插件

  R->>G: 权限请求：npm test
  G->>R: 自动批准（一次性 allow_once）
  G-->>你: 卡片上计数 "auto-approved 1"
  R->>G: 权限请求：git push
  G-->>你: 卡片显示请求 + 原因 "destructive or remote git operation" + Yes/No
  你->>R: No
```

自动批准的范围：读文件、构建、测试、在仓库内编辑。以下请求一律交给你：`rm -rf`、`git push`、`sudo`、发布、云 / 部署工具、密钥文件、仓库外的路径。如果在 `agents.reviewer`（或 `verifier`、`answerer`）里设置 `"permissions": "ask"`，这个角色的每个请求都交给你。

## 场景 8：审查还没结束你就发了新消息

reviewer 正在审查，你又对 agent 说"顺便把日志也改一下"。

```mermaid
sequenceDiagram
  actor 你
  participant A as 开发 agent
  participant G as 插件
  participant R as reviewer

  G->>R: 审查中……
  你->>A: 顺便把日志也改一下
  G->>R: 归档（结果已经过时）
  G-->>你: 旧卡片 SUPERSEDED
  A-->>G: 新一轮完成
  G->>G: 为新一轮重新审查
```

## 场景 9：插件或 daemon 重启

审查进行到一半时 Paseo 重启了。

```mermaid
flowchart LR
  A[重启] --> B[任意 agent 事件到达]
  B --> C[插件拿到 SDK，开始每 60 秒巡检一次]
  C --> D{ledger 里未完成的记录}
  D -- reviewer 已跑完 --> E[读它的时间线，补出结论卡片]
  D -- reviewer 还在跑，但超过 timeout_minutes --> F[ERROR：超时]
  D -- 修复提示没发出去 --> G[重新发送，按 messageId 去重]
  D -- 到点的重试 --> H[发送重试]
```

重启后要等到有 agent 事件进来，巡检才会开始。

## 什么时候插件不介入

| 情况 | 原因 |
|---|---|
| agent 没改文件，包括它最后问了你一句、或者网络出错 | 工作区快照没变。你就在对话里，不需要 answerer 或自动重试 |
| 仓库里没有 `.paseo/post-turn-gate.json` | 没启用 |
| 策略文件写错了 | 不审查，出一张配置错误卡片 |
| 普通子 agent 的轮次 | 默认只管根 agent；子 agent 需要带 `post-turn-gate.target=true` 标签 |
| reviewer / answerer 自己的轮次 | 插件不审查自己派出的 agent |
| 你点了停止 | `user_canceled`，默认忽略 |

## 卡片语言

reviewer 和 answerer 会用原始请求的语言写 summary、问题、回答和 findings，你用中文提问，卡片就是中文。想固定语言，在 `agents` 下对应角色的 `instructions` 里写明，例如 `"instructions": "Write all text in English."`。卡片标题、状态名，以及插件自己的提示语（例如 "You replied first"）目前固定为英文。
