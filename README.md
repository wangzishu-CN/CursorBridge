# CursorBridge

DSH 插件：给 DSH 的主 Agent 加一个 `cursor_cli` 工具，把任务转交给本机安装的 Cursor CLI（`agent`）去跑，再拿回它的输出。

做这个插件的原因很简单：DSH 主 Agent 和 Cursor 的编码 Agent 各有所长，有些活（大范围重构、反复跑测试修 bug、需要长上下文的工作）直接甩给 Cursor 效果更好，而且两边额度独立，可以换着用。

## 安装

先确保本机装好 Cursor CLI 并登录（见 [Cursor 官方文档](https://cursor.com/docs/cli/overview)）：

```sh
curl https://cursor.com/install -fsS | bash
```

然后把本仓库作为 bundle 装进 profile（把 `web` 换成你自己的 profile 名）：

```sh
dsh plugin --profile web add github:wangzishu-CN/CursorBridge
```

包是纯 JS，没有构建脚本，git 安装后直接能用，不需要 allowBuilds 授权。

## 配置

默认配置对 Windows + WSL 开箱即用（自动走 `wsl -e`），一般不用改。可选项：

```yaml
# profile 的 cordis.patch.yml
- id: cursor-bridge
  config:
    useWsl: true          # Windows 下经 WSL 调用
    command: agent        # Cursor CLI 可执行名
    maxOutputChars: 30000 # 返回给模型的输出上限
    defaultTimeoutMs: 600000
    allowForce: true      # 加 --force 让 Cursor 自主执行命令
```

## 使用

主 Agent 会自己判断什么时候用这个工具，直接跟它说就行，例如：

> 让 Cursor 把 src/ 下的 auth 模块重构一遍，补齐测试。

工具参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| prompt | 是 | 给 Cursor 的任务描述 |
| workspace | 否 | 工作目录（Windows 路径会自动转成 WSL 路径） |
| model | 否 | 指定 Cursor 模型，如 composer-2-fast |
| timeoutMs | 否 | 覆盖默认超时 |

## 工作原理

- Windows 上 `spawn('wsl', ['-e', 'agent', ...])`，参数走数组传递、不经过 shell，提示词里有什么特殊字符都不会被解析
- 非 Windows 平台直接执行 `agent`
- Cursor 跑在 `--print` 无头模式，加 `--force` 让它自主执行 shell 命令；不加的话命令审批在无头模式下会被直接拒绝，任务会卡住
- 输出默认截断 30000 字符，完整输出写到临时文件，路径会在结果里给出
- 默认超时 10 分钟，到点杀掉 Cursor 进程，把已产生的输出返回

## 已知限制

- 依赖 Cursor CLI 的登录状态和额度。API 模型额度用尽时（报 `You've hit your usage limit`）任务会直接失败；用 auto 系模型（composer-*）一般没问题
- `--force` 意味着 Cursor 拥有完整的本机权限，只应在信任的环境里用；不信任就把 `allowForce` 关掉（代价是 Cursor 会卡在命令审批上）
- 一次调用串行执行一个任务，没有并发
- 只回传文本输出；Cursor 完整的工具调用记录在它自己的 `~/.cursor/projects/<项目>/agent-transcripts/` 里

## License

MIT
