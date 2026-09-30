# Paseo 上游 PR 设计：结构化的 turn 结束原因

目标：让插件（以及 App、CLI）不再依靠文本匹配或启发式来判断一轮为什么结束。本文是给 `getpaseo/paseo` 的 PR 草案，基于 paseo `3b4118360`。PR 本身尚未提交。

## 1. 问题

`agent.turn_ended` 事件目前只带：

```ts
type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };
```

实测（kiro-cli 2.25，见 [turn-outcomes.md](turn-outcomes.md) §1）和源码中确认的信息丢失有四处：

| # | 丢失的信息 | 位置 | 后果 |
|---|---|---|---|
| L1 | ACP 的 `stopReason` 为 `max_tokens`、`max_turn_requests`、`refusal` 时，一律变成 `turn_completed` | `server/agent/providers/acp-agent.ts` 的 `handlePromptResponse`（`switch (response.stopReason)`） | 截断、轮次上限、拒答与正常完成无法区分 |
| L2 | `turn_failed.diagnostic` 没有传给插件 | `server/plugins/lifecycle/index.ts` 的 `publishAgentStream` | 真正的错误原因（如 `dispatch failure`）只能从一条合成的 `[System Error]` assistant 消息里去读 |
| L3 | 失败没有类别，各 provider 的措辞各不相同；Paseo 源码中没有任何配额、限流类的统一错误码 | 各 provider 的 `turn_failed` | 网络、限流、配额、上下文耗尽只能靠正则判断 |
| L4 | 取消原因只有自由文本（`"Interrupted"`、`"interrupted"`、`"agent closed"`），用户点停止和被新消息打断的 reason 相同 | ACP、codex provider 与 `agent-manager.ts` | 插件只能靠 `refresh()` 查看此刻是否仍在 running 来推断（E3/E4） |

## 2. 提议的 API

向后兼容：只新增可选字段。

```ts
// packages/plugin/src/server/lifecycle.ts
export type PluginTurnOutcome =
  | {
      kind: "completed";
      /** Why the model stopped. Omitted when the provider does not report it. */
      stopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "other";
    }
  | {
      kind: "failed";
      error: {
        message: string;
        code?: string;
        /** Provider-agnostic class; omitted when unknown. */
        category?: "network" | "rate_limited" | "quota_exhausted" | "context_exhausted" | "auth" | "crashed" | "provider";
        /** Seconds the provider asked to wait (e.g. HTTP Retry-After), when known. */
        retryAfterSeconds?: number;
        /** Provider stderr / raw error, as already collected for turn_failed.diagnostic. */
        diagnostic?: string;
      };
    }
  | {
      kind: "canceled";
      reason: string;
      /** Who ended the turn. */
      cause?: "user" | "replaced" | "closed" | "permission_denied";
    };
```

`AgentStreamEvent`（`packages/protocol/src/agent-types.ts` 与 `server/agent/agent-sdk-types.ts`）同步加上：

- `turn_completed.stopReason?`
- `turn_failed.category?`、`turn_failed.retryAfterSeconds?`（`diagnostic` 已存在）
- `turn_canceled.cause?`

插件 provider 协议（`packages/plugin/src/server/provider.ts` 中的 `session.turn` 事件及其 zod schema）加上 `stopReason?`，`ProviderError` 加上 `category?`，这样插件实现的 provider 也能上报。

## 3. 各处改动

| 文件 | 改动 |
|---|---|
| `protocol/src/agent-types.ts`、`server/agent/agent-sdk-types.ts` | 事件类型加可选字段 |
| `server/agent/providers/acp-agent.ts` | `handlePromptResponse`：把 `response.stopReason` 原样写进 `turn_completed.stopReason`（未知值记为 `other`）。`cancelled` 分支先保持现状 |
| `server/agent/providers/acp-agent.ts` | 提供一个导出的 `categorizeProviderError(message, code, data)`：先看 JSON-RPC `code`、`data` 中的 HTTP status（429 → `rate_limited`，401/403 → `auth`），再用一小张措辞表兜底。`summarizeACPRequestError` 调用它；进程退出分支（`ACP agent exited unexpectedly`）直接标为 `crashed` |
| `server/agent/providers/codex-app-server-agent.ts` | 若 codex 的 turn 失败负载里带有错误类型，就映射过来；没有就不填（不猜） |
| `server/agent/providers/claude/agent.ts` | `result` 消息的 `subtype`（`error_max_turns` 等）映射为 `max_turn_requests`，`stop_reason`（`max_tokens`、`refusal`）映射为对应值。需要对照 Claude Agent SDK 的实际类型确认 |
| `server/agent/agent-manager.ts` | 这里发起取消的地方最清楚原因：`replaceRunning` 时为 `cause: "replaced"`；`cancelAgent` 时为 `"user"`；关闭时为 `"closed"`；用户拒绝权限且 `interrupt: true` 时为 `"permission_denied"`。provider 自行发出的 `turn_canceled` 由 manager 在转发前补上 `cause`（manager 在调用 provider 前记下“取消意图”） |
| `server/plugins/lifecycle/index.ts` | `publishAgentStream` 把新字段放进 outcome：`completed.stopReason`；`failed.error.{category, retryAfterSeconds, diagnostic}`，其中 `diagnostic` 截断到 4 KiB；`canceled.cause` |
| `plugin/src/server/provider.ts`、`server/agent/plugin-provider.ts` | 插件 provider 协议透传 `stopReason` 与 `error.category` |
| `public-docs/plugins/reference.md` | “Shared payload shapes” 更新类型与说明：字段可选，缺失表示 provider 未上报 |

不做的事：

- 不改变任何现有行为。`max_tokens` 仍然是 `completed`，只是多了原因。
- 不在 Paseo 里做自动重试；那是插件的策略，由本仓库的 supervision 与 decider 处理。

## 4. 测试

- **`acp-agent.test.ts`**：模拟 `PromptResponse`，`stopReason` 分别取 `end_turn`、`max_tokens`、`max_turn_requests`、`refusal`，断言 `turn_completed.stopReason`。模拟 JSON-RPC 错误，`data` 分别带 429、401 和 `dispatch failure` 措辞，断言 `category`。
- **`agent-manager.test.ts`**：`replaceRunning`、`cancelAgent`、关闭 Agent 三条路径，分别断言 `cause`。
- **`plugins/lifecycle.e2e.test.ts`**：沿用现有的 `turn-hooks` 用例（fake provider），加上 `outcome.cause` 与 `stopReason` 的断言。fake provider（`test-utils/fake-agent-client.ts`）需要支持“按 prompt 触发 max_tokens”。
- **`publishAgentStream`**：对 `diagnostic` 的截断做单测。

## 5. 兼容与发布

- 全部是可选字段，老插件不受影响。新插件用 `outcome.stopReason !== undefined` 来判断宿主是否支持。
- 建议同时在 `server_info.features` 加一个 `pluginTurnOutcomeDetails: true`，供插件在启动时判断（可选）。

## 6. 本插件的适配（PR 合入后）

`server/outcome.ts` 的 `classify()` 改为优先读结构化字段，读不到时才回退到现有的文本匹配和启发式：

| 结构化字段 | 类别 |
|---|---|
| `completed.stopReason` 为 `max_tokens` 或 `max_turn_requests` | `awaiting_user`，信号为 `truncated` / `tool_last`，交给 decider，由它回复 “Continue.” |
| `completed.stopReason` 为 `refusal` | `refused`，不再需要 decider 判断 |
| `failed.error.category` | 直接对应同名类别（`auth` 新增为 `error` 的子类，只通知不重试） |
| `failed.error.retryAfterSeconds` | 覆盖 `retry.delay_seconds` 的下限 |
| `canceled.cause` | `replaced` / `user_canceled`，不再依赖 `refresh()` 的时序 |

## 7. 待确认（提 PR 前）

- 维护者是否接受在 `PluginTurnOutcome` 上加字段，还是更希望新增一个 `agent.turn_outcome` 事件。按 reference 文档的风格，扩展现有事件更自然，先按这个方向提 issue 讨论。
- Claude Agent SDK 的 `result` 消息里 `stop_reason` 与 `subtype` 的确切取值，要对照 SDK 版本确认。
- kiro 的限流、配额错误在 JSON-RPC `data` 里是否带有 HTTP status：需要真的碰到一次时抓取样本（turn-outcomes.md S4 目前只有措辞）。
