# CursorBridge

DSH 插件：把本机安装的 Cursor CLI 注册成 DSH 的一个子 Agent 提供方（provider 名 `cursor`）。DSH 主 Agent 需要时通过标准的子 Agent 委派工具把任务交过去，Cursor 在自己的工作目录里跑完，结果作为子 Agent 的产出回到主 Agent 的对话里。

和"把 cursor 当工具调"不同，走的是 DSH 的 subagent seam：委派、取消、结果映射、会话归属都由 DSH 自己管，Cursor 只是其中一个后端——就像 DSH 自带的 `spawn`/`fork`/`codex`/`claude-code` 提供方一样。

## 安装

先确保本机装好 Cursor CLI 并登录（见 [Cursor 官方文档](https://cursor.com/docs/cli/overview)）：

```sh
curl https://cursor.com/install -fsS | bash
```

把本仓库作为 bundle 装进 profile（把 `web` 换成你自己的 profile 名）：

```sh
dsh plugin --profile web add github:wangzishu-CN/CursorBridge
```

包是纯 JS，没有构建脚本，git 安装后直接能用，不需要 allowBuilds 授权。

装完**重启 DSH 后**：`cursor` 提供方进入子 Agent 提供方列表；**新建的 web 会话**会带 `subagent_cursor` 委派工具。

## Web 会话与 agent preset

web 组合里每个会话的工具集来自 agent preset（默认 `standard`），而 `standard` 刻意不带产品提供方工具。本插件会：

1. 在 `$DSH_HOME/.agent-presets/standard-cursor/` 安装一份组合（复制 `standard` 并加入 `subagent_cursor` 行；已存在时不覆盖）
2. 通过 bundle patch 把 agent preset 默认值改为 `standard-cursor`

因此 **web 的新会话**自动获得 `subagent_cursor`；**已有会话**仍保持创建时的组合，需要在新会话里使用。headless/TUI 组合不走 preset，直接生效。

不想让默认 preset 指向它时，在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: agent-presets
  config:
    default: standard
```

## 配置

默认配置对 Windows + WSL 开箱即用。可选项：

```yaml
# profile 的 cordis.patch.yml
- id: cursor-bridge
  config:
    useWsl: true          # Windows 下经 WSL 调用
    command: agent        # Cursor CLI 可执行名
    model: ""             # 固定传给 Cursor 的模型，留空用 CLI 配置
    force: true           # 加 --force 让 Cursor 自主执行命令
    maxOutputChars: 30000 # 返回给主 Agent 的输出上限
    disposeGraceMs: 3000  # 终止子进程的宽限时间
```

## 使用

主 Agent 会自己判断什么时候派活，直接跟它说就行，例如：

> 让 Cursor 把 src/ 下的 auth 模块重构一遍，补齐测试。

委派工具的参数和 DSH 其他子 Agent 工具一致：`description`（委派说明，作为子 Agent 的显示标签）、`prompt`（任务内容）。子 Agent 的工作目录取父会话的 cwd，Windows 路径会自动转成 WSL 路径。

## 工作原理

- 插件向 `ctx.subagents` 注册名为 `cursor` 的提供方，只做一键式（one-shot）委派，不实现可继续会话
- Windows 上 `spawn('wsl', ['-e', ...])`，参数数组直传、不经过 shell，提示词里有什么特殊字符都不会被解析；非 Windows 平台直接执行 `agent`
- 由于 `wsl -e` 不加载登录 shell 的 PATH（`agent` 通常装在 `~/.local/bin`），首次调用会先经 `bash -lc "command -v agent"` 解析出绝对路径并缓存
- Cursor 跑在 `--print` 无头模式，加 `--force` 自主执行 shell 命令；不加的话命令审批在无头模式下会被直接拒绝，任务会卡住
- 退出码 0 且有输出 → 子 Agent 正常完成；退出码非 0（如额度报错）→ 失败，stderr 摘要随输出返回；父级取消 → 杀掉进程树，按 aborted 结算
- 输出默认截断 30000 字符，截断时给出总长度

## 已知限制

- 依赖 Cursor CLI 的登录状态和额度。API 模型额度用尽时（报 `You've hit your usage limit`）任务会直接失败；用 auto 系模型（composer-*）一般没问题
- `--force` 意味着 Cursor 拥有完整的本机权限，只应在信任的环境里用；不信任就把 `force` 关掉（代价是 Cursor 会卡在命令审批上）
- 一键式委派：没有跨轮次的会话恢复，也没有 `send_message`/`interrupt` 控制工具（那些只对可继续子 Agent 生效）
- 只回传文本输出；Cursor 完整的工具调用记录在它自己的 `~/.cursor/projects/<项目>/agent-transcripts/` 里
- web 组合默认禁用子 Agent 控制工具，需要的话在 profile 里自行启用 `tool-subagent-control`

## License

MIT
