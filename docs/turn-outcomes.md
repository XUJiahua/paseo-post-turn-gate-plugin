# v3 轮次结果处理

[使用入口](../README.md) · [工作流程](workflow.md) · [实现原理](design.md)

## 输入与分类

source turn 结束时，插件接收 completed / failed / canceled、timeline 和 refresh 后的 Agent 状态。completed 只说明本轮结束，不证明整个用户任务完成。

分类函数位于 [server/outcome.ts](../server/outcome.ts)。它只看最新 user_message 后的 turn 内容；真实 assistant 回复排除 Paseo 合成的 `[System Error]` 消息。失败分类使用 error.message 加本轮 System Error 文本，不把 error.code 或裸 HTTP 状态码当成完整错误类别。

| 输入 / 类别 | 判断方式 | 当前处理 |
| --- | --- | --- |
| canceled → replaced | refresh 时 source 为 running，推测新 turn 已接手 | 不启动 decider，保留任务范围给新 turn |
| canceled → user_canceled | 其余 canceled | 不启动 decider；未接受改动保留，等待用户下一轮 |
| failed → crashed | 进程退出、SIGKILL/SIGTERM、spawn ENOENT 等文本 | 预算内机械重试，次数用尽后交 decider |
| failed → context_exhausted | context limit/window/length、too many tokens 等文本 | 直接交给用户，不重试、不启动 decider |
| failed → quota_exhausted | quota exceeded、usage limit、insufficient quota/credits、billing 等文本 | 直接交给用户，不重试、不启动 decider |
| failed → rate_limited | too many requests、throttl、rate limit、overloaded 等明确文本 | 预算内机械重试，用尽后交 decider |
| failed → network | dispatch failure、ECONN、ETIMEDOUT、DNS/网络错误、502/503/504 等文本 | 预算内机械重试，用尽后交 decider |
| failed → error | 以上未匹配；包括只有 429 或 “try again later” 的错误 | 交 decider 判断继续或找人，不机械重试 |
| completed → awaiting_user | 回复有 stopSignal，包括空回复、提问或未完成提示 | 有工作/改动时进入 decider；空回复即使无改动也进入 |
| completed → done | 没有 stopSignal | 任务有改动则走立即检查/PASS 捷径；无改动则结束 |

失败文本按表中顺序匹配，quota 在 rate_limited 之前，避免“quota exceeded, please wait”误触发重试。分类依赖文本，换措辞后可能变成 error；代码无法补回宿主丢弃的信息。

canceled 的类别名称是推断，并不证明谁停止了 turn。用户 Stop、其他客户端、daemon 关闭可能产生同样的结果，所以卡片只说 “The turn was stopped.”。

## completed 的 stopSignal

| 信号 | 条件 |
| --- | --- |
| missing_reply | 没有有效 assistant 回复，包括空字符串、空白或只有 System Error |
| refused | 回复开头命中拒答措辞 |
| truncated | Markdown 代码块未闭合 |
| tool_last | 最后一个相关内容是 tool_call |
| todo_pending | 最后的 todo 仍有未完成项 |
| question | 回复结尾有真实提问，而非普通完成报告的单句客套结尾 |

这些信号是预筛，不是 provider 的结构化 stopReason。拒答首先表现为 awaiting_user 的信号，decider 再判断 refused 等 assessment；没有最终标点不是未完成信号，正文里出现一个问号也不足以触发。

有正常回复、没工具调用、任务树没变化且没有既有工作范围的纯聊天问题不自动代答。无改动的正常 done 也不调用 checker；失败和 missing_reply 则不能用纯聊天跳过。

## 重试与人工处理

crashed/network/rate_limited 默认最多机械重试三次，依次等待 30 秒、2 分钟、8 分钟，消息是 “Continue from where you left off.”。次数可以设为 0；机械重试与自动答案共同消耗 max_auto_sends。

发送前检查保存的 revision、source idle/error 状态和权限；用户接管、Stop 或状态变化会跳过过期重试。ack 丢失后使用接收证据对账，无证据就暂停，不重试同一消息。详细规则见[发送与交付确认](design.md#发送与交付确认)。

quota/context 耗尽需要用户调整模型、配额或会话；未知错误交 decider，因此不机械重试不等于不会再产生模型调用。没有凭据、服务或足够证据时应向用户说明所缺条件。

## 能力边界

Paseo 目前没有完整提供 provider stopReason、统一错误类别和取消来源。截断或失败被适配层压成 completed、且回复没有明显信号时，插件仍可能先启动检查。verifier 的任务验收与 turn 分类是两种证据，不能相互替代。

分类规则的回归测试在 [server/outcome.test.ts](../server/outcome.test.ts)，工作流与发送竞态测试在 [server/gate.test.ts](../server/gate.test.ts)。宿主契约缺口见 [issue #2](https://github.com/XUJiahua/paseo-post-turn-gate-plugin/issues/2)。
