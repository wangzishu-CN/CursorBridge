// @ts-check
// cursor-bridge: registers `cursor` as a DSH subagent provider. The main agent
// delegates through the standard subagent tool; this provider spawns the local
// Cursor CLI (`agent`) and turns its text output into the child result.
//
// On Windows the CLI lives in WSL, so the spawn goes through `wsl -e` with the
// argument array passed straight through — no shell, nothing to escape.
//
// The provider implements the subagent seam contract itself (settle/run-handle
// below) instead of importing @deepseek-ai/dsh-subagent, because the npm
// release trails the installed runtime; the runtime services are called by
// shape only.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

export const name = 'cursor-bridge'
export const inject = ['subagents', 'subprocess']

export const Config = z.object({
  // Windows 下经 WSL 调用；其他平台直接执行
  useWsl: z.boolean().default(process.platform === 'win32'),
  // Cursor CLI 可执行名（WSL 里通常是 agent）
  command: z.string().default('agent'),
  // 固定传给 Cursor 的模型；留空用 CLI 配置的默认模型
  model: z.string().default(''),
  // 加 --force，让 Cursor 自主执行 shell 命令（不加会在审批上卡死）
  force: z.boolean().default(true),
  // 返回给主 Agent 的输出上限，超出部分截断
  maxOutputChars: z.number().default(30000),
  // 子进程终止的宽限时间（毫秒）
  disposeGraceMs: z.number().default(3000),
})

// 环境里带敏感名（KEY/PASSWORD/SECRET/TOKEN）的变量不传给子进程。
// 与 @deepseek-ai/dsh-subprocess 的 scrubbedParentEnv 行为一致。
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
function scrubbedParentEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key)) {
      env[key] = value
    }
  }
  return env
}

// C:\foo\bar -> /mnt/c/foo/bar
function toWslPath(p) {
  if (!/^[A-Za-z]:[\\/]/.test(p)) return p
  return '/mnt/' + p[0].toLowerCase() + '/' + p.slice(3).replaceAll('\\', '/')
}

// 子任务只允许文本块，按顺序拼成一个提示词
function textTask(prompt) {
  const texts = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('cursor-bridge: the delegated task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.length === 0 || texts.every((t) => t.trim().length === 0)) {
    throw new Error('cursor-bridge: the delegated task must not be empty')
  }
  return texts.join('\n')
}

// 结算一次子进程 run 的结果：正常完成、本地取消或失败分别映射为
// completed / aborted / error，与 @deepseek-ai/dsh-subagent 的
// settleRunResult 行为一致。
async function settleRunResult(parts) {
  try {
    const result = await parts.attempt()
    return parts.cancelled()
      ? { output: parts.collectOutput(), stopReason: 'aborted' }
      : result
  } catch (error) {
    if (parts.cancelled()) {
      return { output: parts.collectOutput(), stopReason: 'aborted' }
    }
    try {
      parts.onError?.(error instanceof Error ? error : new Error(String(error)), 'error')
    } catch {
      // 诊断回调本身失败不影响结算
    }
    return { output: parts.collectOutput(), stopReason: 'error' }
  } finally {
    parts.signal.removeEventListener('abort', parts.onAbort)
  }
}

// 发布 subagent run 句柄。dispose 幂等：移除 abort 监听、结算本地取消、
// 等待进程树真正退出。
function subprocessRunHandle(parts) {
  let disposal
  return {
    id: parts.id,
    localAgent: undefined,
    result: parts.result,
    dispose() {
      if (disposal !== undefined) return disposal
      parts.signal.removeEventListener('abort', parts.onAbort)
      parts.requestCancel()
      disposal = parts.teardown()
      return disposal
    },
  }
}

class CursorProvider {
  name = 'cursor'
  // 一键式委派：不支持 outputSchema / depthLimit / toolFilter / persona
  capabilities = Object.freeze({
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  })
  inheritsParentContext = false

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.commandPath = null
  }

  // `wsl -e` 直接 exec 程序，不经过 shell，也就没有登录 shell 的 PATH
  // （agent 通常装在 ~/.local/bin）。先经 bash 解析出绝对路径再执行。
  async resolveCommand() {
    if (this.commandPath) return this.commandPath
    if (!this.config.useWsl) {
      this.commandPath = this.config.command
      return this.commandPath
    }
    const child = this.ctx.subprocess.spawn({
      argv: ['wsl', '-e', 'bash', '-lc', `command -v ${this.config.command} || true`],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
      graceMs: this.config.disposeGraceMs,
      env: scrubbedParentEnv(),
    })
    let out = ''
    child.stdout?.on('data', (d) => { out += d })
    await child.done
    this.commandPath = out.trim().split('\n')[0] || null
    return this.commandPath
  }

  async start(request) {
    const prompt = textTask(request.prompt)
    if (request.signal.aborted) {
      throw new Error('cursor-bridge: request was aborted before CLI startup')
    }

    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error('cursor-bridge: no working directory for the child — delegate from a parent session that has one')
    }
    const commandPath = await this.resolveCommand()
    if (!commandPath) {
      throw new Error(`cursor-bridge: "${this.config.command}" not found; install Cursor CLI with: curl https://cursor.com/install -fsS | bash`)
    }

    const argv = []
    if (this.config.useWsl) argv.push('wsl', '-e')
    argv.push(commandPath, '-p', prompt, '--trust', '--print', '--output-format', 'text')
    if (this.config.force) argv.push('--force')
    if (this.config.model) argv.push('--model', this.config.model)
    argv.push('--workspace', this.config.useWsl ? toWslPath(parentCwd) : parentCwd)

    const child = this.ctx.subprocess.spawn({
      argv,
      cwd: parentCwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.config.disposeGraceMs,
      env: scrubbedParentEnv(),
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })

    const runAbort = new AbortController()
    const requestCancel = () => {
      if (runAbort.signal.aborted) return
      runAbort.abort(new Error('cursor-bridge: run cancelled locally'))
      child.terminate()
    }
    const onAbort = () => { requestCancel() }
    request.signal.addEventListener('abort', onAbort, { once: true })

    const dispose = async () => {
      child.terminate()
      await child.waitForExit().catch(() => {})
      await child.done.catch(() => {})
    }

    const collectOutput = () => {
      const full = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n').trim()
      if (!full) return []
      if (full.length <= this.config.maxOutputChars) {
        return [{ type: 'text', text: full }]
      }
      const tail = full.slice(-this.config.maxOutputChars)
      return [{ type: 'text', text: `[output truncated, ${full.length} chars total]\n${tail}` }]
    }

    const result = settleRunResult({
      attempt: async () => {
        const outcome = await child.done
        if (runAbort.signal.aborted) {
          return { output: collectOutput(), stopReason: 'aborted' }
        }
        if (outcome.exitCode !== 0) {
          throw new Error(`cursor-bridge: CLI exited with code ${String(outcome.exitCode)}`)
        }
        const output = collectOutput()
        if (output.length === 0) {
          throw new Error('cursor-bridge: CLI exited 0 but produced no output')
        }
        return { output, stopReason: 'completed' }
      },
      collectOutput,
      cancelled: () => runAbort.signal.aborted,
      onError: (error, stopReason) => {
        this.ctx.logger.warn(`cursor-bridge: child run failed (${stopReason}): ${error.message}`)
      },
      signal: request.signal,
      onAbort,
    })

    return subprocessRunHandle({
      id: randomUUID(),
      result,
      signal: request.signal,
      onAbort,
      requestCancel,
      teardown: dispose,
    })
  }
}

export function apply(ctx, config) {
  ctx.subagents.registerProvider(new CursorProvider(ctx, config))
}
