# turn-keepalive：后续不进入 idle

DSH（DeepSeek Harness）插件。**只要当前会话还有自己拥有的后台 job 没结算，就不允许回合关闭。**

解决的问题：模型起了后台任务后结束回合，会话进入 idle，等待 job 结算时的完成通知来唤醒它。如果这个 job 永远不结算（进程卡死、`sleep infinity`、卡在 IO），就再也不会有人叫醒它——"睡死"。

装上之后，回合关不掉，模型一直在跑，每一轮都能看到 job 的 id、类型、运行时长，自己判断要不要 `job_kill`。

## 原理

挂 `agent/turn-stopping`（回合即将关闭、且没有待处理工具调用时的检查点）。发现本会话还有 `running` / `stopping` 的 job，就调用 `agent.steer(...)` 把一条提示塞回模型，回合被重新打开：

```
模型想收工 → turn-stopping 拦截 → steer
   → 模型 job_output(wait: true, timeout_ms: 120000) → [status: running]
   → 想收工 → 再拦（两次之间至少间隔 minSteerIntervalMs）
   → ... 直到 job 结算 / 模型 job_kill / 用户中止
```

它不是"定时唤醒"：回合根本没有关闭，会话从头到尾是 `running`。

## 安装

需要：DSH 已安装，且 `dsh` 在 `PATH` 上；目标 profile 已存在。

```bash
git clone git@github.com:atomic-kernel/dsh_noidle.git
cd dsh_noidle
./install.sh dsh-tui      # 或者你的 profile 名
```

脚本做三件事：把 `plugin/` 复制到 `~/.dsh/profiles/<profile>/plugins/turn-keepalive/`；在 `cordis.patch.yml` 末尾追加一次 loader 行（已有则跳过）；用 `dsh --profile <profile> --dump-config` 确认组合里能看到这一行。

**重启 dsh 生效。**

### 手动安装

```bash
mkdir -p ~/.dsh/profiles/<profile>/plugins
cp -R plugin ~/.dsh/profiles/<profile>/plugins/turn-keepalive
```

然后在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: turn-keepalive
      name: ./plugins/turn-keepalive/index.js
      config:
        minSteerIntervalMs: 120000
```

相对路径是相对 patch 文件解析的，所以插件必须放在 profile 目录下。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `minSteerIntervalMs` | `120000` | 同一 agent 两次 steer 的最小间隔。首次立即触发，之后按这个间隔限速，防止模型秒回秒关导致自旋 |
| `kinds` | 全部 | 只拦指定的 job 类型，例如 `['bash']` |

## 验证

```bash
node test/keepalive.test.mjs
```

9 项检查，不依赖 DSH 运行时（用假 ctx / agent）。它会尝试从 `command -v dsh` 找到安装路径，以复用官方 `createUserMessage`；找不到则走内置字面量，两条路径都被覆盖（`DSH_BIN=/nonexistent/node node test/keepalive.test.mjs`）。

安装后的冒烟测试：

1. 重启 dsh。
2. 让 agent 起一个长任务，比如 `sleep 300`（后台）。
3. 让 agent 结束回合。
4. 预期立刻被拽回，出现 `回合不能结束：还有 1 个后台任务未结算。`
5. `job_kill` 掉它，回合正常结束。

## 已知限制

- **不会强制 kill。** 它只保证模型不睡死；是否 `job_kill` 仍由模型判断。一个执意空等的模型会每 `minSteerIntervalMs` 烧一次请求。
- **只认自己的 job。** 通过 `ctx.jobs.list(sessionId)` 后按 `owner === agent.session.id` 过滤；无主 job 和其他会话的 job 不会锁住你的回合。
- **用户中止优先。** `signal.aborted` 时不 steer，`Esc` 能正常停下。
- **插件没加载或事件改名时会静默失效。** 升级 DSH 后请重跑一次冒烟测试。

## 兼容性

在 DSH `0.2.2-rc.5` 上验证。依赖的公开面：

- `agent/turn-stopping`（`docs/subsystems/core.md`，serial / awaited）
- `ctx.jobs.list(caller?)` 与 `JobView` 的 `id` / `kind` / `status` / `owner` / `startedAt` / `progress`
- `agent.steer(UserMessage)`
- `createUserMessage`（从运行中的安装动态解析，跟随版本）

## 卸载

删掉 `cordis.patch.yml` 里的 `turn-keepalive` insert 块，重启。插件文件留着不会被加载。

## English

`dsh_noidle` / `turn-keepalive` is a DSH plugin that refuses to close a turn while the session still owns a running background job. It hooks `agent/turn-stopping` and steers the model instead of letting it go idle, so a job that never settles cannot leave the session asleep forever. Install with `./install.sh <profile>` and restart DSH.
