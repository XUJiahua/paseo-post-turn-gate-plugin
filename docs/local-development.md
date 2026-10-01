# 本地开发与测试

无需更新 Paseo upstream 即可运行这一轮优化。开发基线是 Node 24、npm、Git、Paseo CLI/server 0.10.1，以及仓库锁定的 SDK 0.10.1。无需模型凭据即可完成类型检查、回归测试和真实宿主冒烟；真实模型 turn 另行验证。

## 1. 安装与回归测试

在本仓库目录执行：

```bash
npm ci
npm run typecheck
npm test
```

测试使用临时 Git 仓库和 SQLite，覆盖用户 hook 在队列处理中到达、最后 refresh 时 Stop、发送 ack 丢失、重载不重发、发送记录持久化、timeline 分页、空回复和不明确的 429、启动连接重试与关闭。

## 2. 真实 Paseo 宿主冒烟

可以使用已有的 `paseo`，或安装一个隔离的固定版本：

```bash
npm install --prefix /tmp/post-turn-gate-host @getpaseo/cli@0.10.1
node scripts/dev-smoke.mjs /tmp/post-turn-gate-host/node_modules/.bin/paseo
# 已有 CLI 时：node scripts/dev-smoke.mjs
```

脚本创建临时 `PASEO_HOME`、选择本地空闲端口、关闭 relay 与语音，启动真实 daemon 并安装当前 checkout。它验证插件加载、没有 Agent hook 时启动 reconcile、reload 和 disable，然后停止 daemon 并清理临时目录。不会创建模型 turn，也不验证模型结果或真实聊天卡片交互。

## 3. 可选的无事件启动恢复

默认继续沿用首个 hook/RPC 提供 SDK 的恢复入口。需要在 daemon 启动后主动恢复时，在 **daemon 进程的环境**里配置实际监听地址：

```bash
export POST_TURN_GATE_RECOVERY_URL='ws://127.0.0.1:7791/ws'
paseo daemon run
```

`7791` 只是例子，应与自己的 daemon 监听端口一致。已运行的 daemon 不会读取另一终端后来设置的变量，需要在带有该环境的进程中重新启动。地址只接受显式 loopback WebSocket URL；不猜端口、不连接远端、不在 URL 中放认证信息。需要认证时使用 `POST_TURN_GATE_RECOVERY_PASSWORD`，由现有凭据管理方式注入，避免写入仓库或命令记录。

连接成功立即 reconcile，之后沿用每 60 秒的周期；连接失败每 5 秒重试，正常 hook/RPC 仍可触发恢复。卸载会停止连接和计时器。查看 `paseo plugin logs post-turn-gate` 中的 `Startup recovery connected; reconciliation started.` 确认入口启动。

## 4. 本地 workaround 的效果与边界

| 改动 | 解决的问题 | 仍然存在的边界 |
| --- | --- | --- |
| hook 入队前持久化 source revision，派发前复查 | 已经收到用户 turn、取消或 Stop 时，旧回复和旧重试不再发送 | 最后一次检查到宿主接收之间仍非原子 |
| 同步发送意图和预算，ack/timeline 对账 | 异常或重载后不盲目重发可能已接收的消息 | 无正向证据时暂停，可能需要人工恢复；没有 exactly-once 保证 |
| source messageId 有界分页 | 已发送消息不在尾部 500 条时仍有机会找到 | 最多 10 页；gap、epoch 变化或找不到都保留不确定状态 |
| 空回复进入 decider，裸 429 不机械重试 | 降低空输出被当作完成、配额耗尽被连续重试的概率 | 仍缺少结构化 stopReason、错误类别与取消来源 |
| 显式本地 SDK 启动连接 | 无 Agent 事件时也可开始恢复 | 需配置本地地址与认证；不能替代 upstream ready API |

不确定发送会消耗一次预算并暂停自动回答。确认聊天记录后，用户发送新消息接管，或使用 Resume 允许后续 turn；两者都不重放旧消息。升级前保存的旧决策缺少 revision 时交给用户重新开始，不猜测它仍有效。

源 Agent 已经在专属 worktree 时，无需为这轮优化再建一个源 worktree。检查者仍共享该目录、串行执行并比较 tree；隔离检查者快照属于另一项工作。
