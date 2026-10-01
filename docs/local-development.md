# v3 本地开发与测试

[使用入口](../README.md) · [配置指南](configuration.md) · [实现原理](design.md)

## 环境与本地安装

需要 Node 24、npm、Git。仓库锁定 plugin/client SDK 0.10.1；真实宿主冒烟基线为 Paseo CLI/server 0.10.1。类型检查、回归测试与无模型宿主冒烟不需要模型凭据；真实 source/checker/decider turn 需要已配置的 provider 与认证。

```bash
git clone https://github.com/XUJiahua/paseo-post-turn-gate-plugin.git
cd paseo-post-turn-gate-plugin
npm ci
npm run typecheck
npm test
```

连接已有的开发 daemon 后安装 checkout：

```bash
paseo plugin install "$PWD"
paseo plugin ls post-turn-gate --json
```

修改后使用 `paseo plugin reload post-turn-gate`。目标仓库启用步骤见 [README](../README.md#3-在目标仓库启用)，从当前 checkout 初始化可运行 `npm run init -- --dir /path/to/target-repo`。本地路径安装的代码通过 Git 更新，再 reload；GitHub 管理的安装才使用 plugin update。

## 回归测试覆盖

测试使用临时 Git 仓库、SQLite 和 fake Paseo，覆盖：

- 策略默认值、初始化文件、安装任务模板和角色规则路径。
- baseline、跨 turn 任务范围、PASS 捷径、FAIL/INCONCLUSIVE、用户接管与停止。
- 启动设置继承、权限等待、角色超时、任务/角色恢复与 workspace 队列。
- 用户 turn 或 Stop 在最终 refresh 时到达、ack 丢失有/无接收证据、重载不重发。
- SQLite 重开后的 revision/发送记录、timeline 分页边界、空回复和模糊 429。
- 无 hook 启动连接、失败重试、重新连接和卸载时的迟到回调。

类型检查和单元/集成测试不证明真实 provider 的全部行为，特别是结构化输出、权限上报和模型判断。

## 真实宿主冒烟

使用已有 paseo CLI，或安装隔离的固定版本：

```bash
npm install --prefix /tmp/post-turn-gate-host @getpaseo/cli@0.10.1
node scripts/dev-smoke.mjs /tmp/post-turn-gate-host/node_modules/.bin/paseo
# 已有 CLI 时：node scripts/dev-smoke.mjs
```

脚本创建临时 PASEO_HOME、选择本地端口，关闭 relay/语音，启动真实 daemon 并安装当前 checkout。验证插件加载、无 Agent hook 时启动 reconcile、reload 后重新连接和 disable，最后停止 daemon、清理临时目录。

此脚本不创建模型 turn，不验证真实聊天卡片交互或带模型任务的完整重启恢复；连接日志仅证明恢复入口启动。普通 daemon 的无事件恢复配置见[可选启动恢复](configuration.md#可选启动恢复)。

## 真实模型工作流验证

在单独的目标 Git 工作区启用策略，使用已配置的 provider，通过 Paseo 聊天验证以下场景，并观察卡片、source timeline 和 `paseo logs <id>`：

| 场景 | 应观察到什么 |
| --- | --- |
| 小型代码修改，正常完成，检查通过 | verify/review 按顺序执行；PASS 完成，不产生 decider 回复 |
| 检查可复现一个缺陷 | FAIL 反馈回 source，修复后重新检查 |
| 有工作后问一个需求已确定的问题 | decider 代答；与修复要求需要时合并为一条消息 |
| 宽限期内发送新消息、点 Stop auto-answering | 旧决策失效，不发旧回复；Resume 对下一 turn 生效 |
| 角色请求权限、被拒或超过等待时间 | 卡片请求与后续 verdict/人工处理一致 |
| pending 角色或待执行决策期间 reload | 现有角色/任务被对账，创建使用原 id/key；无未知消息盲目重发 |

这是一组验证步骤，不是所有 provider 均已通过的声明。保留实际 provider、版本、配置和观察证据，按当前[保证边界](design.md#恢复与当前保证)解释结果。
