# v3 配置指南

[使用入口](../README.md) · [工作流程](workflow.md) · [实现原理](design.md)

## 策略文件与生效范围

策略位于目标 Git 根目录的 `.paseo/post-turn-gate.json`，而非插件安装目录或任意子目录。唯一支持的格式是 `version: 3`。JSON 对象采用严格 schema，未知字段会报错；省略可选字段会使用默认值。最小策略是 `{ "version": 3 }`。

新任务在 `turn_started` 时读取策略和三个角色的规则，保存 baseline 与策略快照。规则在本轮中被修改也不会改变已保存的内容。已有任务链的后续 turn 沿用同一策略快照，不会因为发了新消息就重新读取文件；修改后应在新的任务链或新 Agent 中验证。profile 和源模型启动设置在创建角色时解析。

没有策略文件、cwd 不在 Git 工作区、Agent 不命中 trigger 时不监督。无效策略仅在有改动且命中触发条件的 turn 发布配置错误卡；无法取得 baseline 时也会显示错误。

## 完整默认策略

```json
{
  "version": 3,
  "trigger": "root_and_opt_in",
  "supervision": {
    "checks": ["verify", "review"],
    "speculative_checks": true,
    "reply_delay_seconds": 60,
    "budget": {
      "max_auto_sends": 12,
      "max_retries": 3,
      "max_no_progress_rounds": 2,
      "max_minutes": 120
    }
  },
  "agents": {
    "decider": {
      "profile": null,
      "instructions_file": ".paseo/post-turn-gate/decider.md",
      "permissions": "auto",
      "timeout_minutes": 10,
      "permission_wait_minutes": 5
    },
    "verifier": {
      "profile": null,
      "instructions_file": ".paseo/post-turn-gate/verifier.md",
      "permissions": "auto",
      "timeout_minutes": 30,
      "permission_wait_minutes": 5
    },
    "reviewer": {
      "profile": null,
      "instructions_file": ".paseo/post-turn-gate/reviewer.md",
      "permissions": "auto",
      "timeout_minutes": 30,
      "permission_wait_minutes": 5
    }
  }
}
```

## 触发范围

| `trigger` | 处理哪些 Agent |
| --- | --- |
| `root_only` | 没有父 Agent 的根 Agent |
| `root_and_opt_in`（默认） | 根 Agent，以及带 `post-turn-gate.target=true` 标签的子 Agent |
| `all` | 其他满足仓库条件的 Agent，包括普通子 Agent |

插件创建的角色带 `post-turn-gate.managed=true`，不会再次触发监督；它们已识别的后代也被排除。祖先识别最多上溯 10 层，无法访问或超出深度的祖先不提供完整排除保证。标签是 Paseo Agent 元数据，不是策略 JSON 的配置项。

## 检查、等待与预算

| 字段 | 默认值 | 可用值 / 范围 | 含义 |
| --- | --- | --- | --- |
| `supervision.checks` | `["verify", "review"]` | 非空数组；verify、review 各最多一次 | 可运行的检查及顺序。verify 验收需求，review 检查代码质量；共享目录内串行执行 |
| `supervision.speculative_checks` | `true` | boolean | 有改动时可在 decider 出计划前开始检查；普通完成的 PASS 捷径即使设为 false 也立即检查 |
| `supervision.reply_delay_seconds` | `60` | 整数 0–3600 | turn 结束到 decider 启动的宽限期；用户先回复则取消旧决策；检查全部 PASS 可以提前结束 |
| `supervision.budget.max_auto_sends` | `12` | 整数 1–50 | 自动发给 source 的代答与机械重试总数；不包含用户消息或所有角色模型调用 |
| `supervision.budget.max_retries` | `3` | 整数 0–3 | 崩溃、网络、限流的机械重试次数，依次等 30 秒、2 分钟、8 分钟；计入总发送数 |
| `supervision.budget.max_no_progress_rounds` | `2` | 整数 1–10 | 决策轮 tree 连续与上轮相同的次数上限；默认连续第三轮同 tree 时交给用户 |
| `supervision.budget.max_minutes` | `120` | 整数 1–1440 | 进入决策轮时检查自动处理时长，超限交给用户；不是强制终止所有角色的定时器 |

用户接管后进入新的决策轮会重置自动预算，同时保留任务原始 baseline。无进展只比较 Git tree，新增证据但文件不变不算 tree 进展。角色调用数不等于 `max_auto_sends`；检查、decider 阶段和权限追问都有独立调用成本。

只做 code review 的示例：

```json
{
  "version": 3,
  "supervision": {
    "checks": ["review"],
    "reply_delay_seconds": 30
  },
  "agents": {
    "reviewer": { "permissions": "ask" }
  }
}
```

## 角色设置

`agents.decider`、`agents.verifier`、`agents.reviewer` 支持相同字段：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `profile` | `null` | 可选 Paseo 启动 profile，按 id 优先、再按准确名称匹配；null 继承 source |
| `provider` | 继承 | provider id；这里不写成 provider/model |
| `model` | 继承 | 对应 provider 的模型 id |
| `mode` | 继承 | provider 的 mode id |
| `thinking` | 继承 | 模型支持的 thinking option id |
| `features` | 继承 | feature 名到值的对象，字段覆盖同 provider 的已继承设置 |
| `instructions_file` | `.paseo/post-turn-gate/<role>.md` | 相对 Git 根目录的规则路径，null 关闭文件规则 |
| `instructions` | 无 | 追加的 inline 规则 |
| `permissions` | `auto` | auto 批准常规请求、高风险上卡；ask 将每个请求交给用户 |
| `timeout_minutes` | decider 10；checker 30 | 整数 1–240，含权限等待；超时结束角色工作并交给用户 |
| `permission_wait_minutes` | `5` | 整数 1–240，卡片权限请求等待多久后自动拒绝 |

启动设置按 **source → profile → 显式字段** 叠加。同 provider 保留未覆盖的 model、mode、thinking、features；切换 provider 时清空上一层 provider 专属设置，需要确保能解析到新 provider 的 model。角色的 `plan_mode` feature 若存在，会被强制设为 false，以便结束时输出结构化结果。

角色 prompt 和 JSON 契约由插件提供，profile 只负责启动设置。正常安装无需 profile；自定义 profile 缺失或名称重复时应修正 id/名称。需要共享启动设置时，可在插件 checkout 中运行：

```bash
npm run profiles -- --help
npm run profiles -- --provider '<provider-id>' --model '<model-id>' --dry-run
```

确认输出后去掉 `--dry-run`。脚本更新本地 daemon 的三个 `post-turn-gate-<role>` profiles，校验 provider/model 并默认 reload daemon；不会自动修改仓库策略。需要使用时显式设置 `agents.<role>.profile`。

## 编写角色规则

规则文件是提交到目标仓库的项目约定。HTML 注释是编辑提示，运行时会剥离。文件规则加 inline 规则合计最多 20,000 字符；默认路径缺失表示无文件规则，自定义路径必须存在。路径和真实符号链接目标都必须留在仓库内。

| 文件 | 应写的内容 |
| --- | --- |
| `verifier.md` | 验收来源、准确的测试命令、环境前提、需要观察的证据 |
| `reviewer.md` | 架构边界、正确性约束、阻塞缺陷、项目允许的例外 |
| `decider.md` | 已确定的接口/依赖选择、可逆决定、必须交给用户的产品或外部动作 |

例如 verifier 可以写“接口变更必须运行项目已定义的 npm test 和 npm run typecheck；若数据库不可用，说明缺失证据”。命令应来自目标项目的 manifest 或 CI。不要把未执行的测试写成已验证，不要让 decider 推翻 FAIL。

角色自由文本跟随原请求语言；需要固定语言可设置 `instructions: "Write all text in Chinese."`。插件自身状态文案为英文。

## 初始化命令

在已安装插件的 checkout 中运行 `node bin/post-turn-gate-init.mjs`，或在开发 checkout 中用 `npm run init --`：

| 参数 | 效果 |
| --- | --- |
| `--dir <path>` | 目标 Git 仓库，默认当前目录；使用 Git 根目录 |
| `--check verify,review` | 检查列表与顺序；可只选一项，不可重复 |
| `--stdout` | 只打印策略，不写文件 |
| `--force` | 覆盖已存在策略；角色规则始终保留 |
| `--agent-prompt` | 打印编码 Agent 安装定制任务，填入目标路径；不写文件 |
| `--help` | 查看帮助 |

```bash
npm run init -- --dir /path/to/repo --check review
npm run init -- --stdout
npm run init -- --agent-prompt --dir /path/to/repo
```

`--agent-prompt` 不能与 `--stdout`、`--force` 合用。模板见 [install-with-agent.md](install-with-agent.md)。初始化程序与运行插件应使用同一版本。

## 可选启动恢复

默认由首个 hook/RPC 提供 SDK，开始立即及每 60 秒的 reconcile。要在没有 Agent 活动时也启动恢复，在 **daemon 进程环境**中配置：

```bash
export POST_TURN_GATE_RECOVERY_URL='ws://127.0.0.1:7791/ws'
paseo daemon run
```

7791 是示例端口，替换为实际监听地址。只接受 ws/wss 的显式 localhost、127.0.0.1 或 IPv6 loopback（如 `ws://[::1]:7791/ws`）；拒绝 URL 中的凭据、query 和 fragment。插件不猜端口、不连接远端。

需要认证时通过 `POST_TURN_GATE_RECOVERY_PASSWORD` 注入，避免写入 URL 或仓库。已运行的 daemon 不会读取另一终端后来设置的变量，应在正确环境中重新启动。

```bash
paseo plugin logs post-turn-gate
```

`Startup recovery connected; reconciliation started.` 表示恢复入口已启动，不代表所有任务已恢复。连接失败每 5 秒重试，hook/RPC 仍可工作；卸载关闭连接与计时器。对账与保证边界见[实现原理](design.md#恢复与当前保证)。
