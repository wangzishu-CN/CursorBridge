// @ts-check
// cursor-bridge: a DSH tool that delegates a task to the local Cursor CLI.
//
// The tool spawns `agent` (the Cursor CLI) with the prompt and returns its
// text output. On Windows the CLI lives inside WSL, so the spawn goes through
// `wsl -e`; the argument array is passed straight through, no shell involved.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'cursor-bridge'
export const inject = ['tools']

export const Config = z.object({
  // Windows 下经 WSL 调用；其他平台直接执行
  useWsl: z.boolean().default(process.platform === 'win32'),
  // Cursor CLI 可执行名，需在 PATH 中（WSL 里通常是 agent）
  command: z.string().default('agent'),
  // 返回给模型的输出上限，超出部分截断、完整输出落临时文件
  maxOutputChars: z.number().default(30000),
  // 默认超时（毫秒），单次调用可用 timeoutMs 覆盖
  defaultTimeoutMs: z.number().default(600000),
  // 加 --force，让 Cursor agent 自主执行 shell 命令（不加会在审批上卡死）
  allowForce: z.boolean().default(true),
})

// C:\foo\bar -> /mnt/c/foo/bar
function toWslPath(p) {
  if (!/^[A-Za-z]:[\\/]/.test(p)) return p
  return '/mnt/' + p[0].toLowerCase() + '/' + p.slice(3).replaceAll('\\', '/')
}

// `wsl -e` 直接 exec 程序，不经过 shell，也就没有登录 shell 的 PATH
// （agent 通常装在 ~/.local/bin）。先经 bash 解析出绝对路径再执行。
let commandPathCache = null
async function resolveCommand(config) {
  if (!config.useWsl) return config.command
  if (commandPathCache) return commandPathCache
  const { stdout } = await runAgent(['wsl', '-e', 'bash', '-lc', `command -v ${config.command} || true`], {
    timeoutMs: 15000,
    signal: undefined,
  })
  commandPathCache = stdout.trim().split('\n')[0] || null
  return commandPathCache
}

function buildArgv(commandPath, config, args) {
  const argv = []
  if (config.useWsl) argv.push('wsl', '-e')
  argv.push(
    commandPath,
    '-p', args.prompt,
    '--trust',
    '--print',
    '--output-format', 'text',
  )
  if (config.allowForce) argv.push('--force')
  if (args.model) argv.push('--model', args.model)
  if (args.workspace) {
    argv.push('--workspace', config.useWsl ? toWslPath(args.workspace) : args.workspace)
  }
  return argv
}

function runAgent(argv, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      child.kill()
      settled = true
      resolve({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)

    const kill = () => child.kill()
    if (signal?.aborted) kill()
    else signal?.addEventListener('abort', kill, { once: true })

    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: false })
    })
  })
}

export function apply(ctx) {
  const config = ctx.config

  ctx.tools.register(defineTool({
    name: 'cursor_cli',
    description: 'Delegate a task to the local Cursor CLI and return its text output. '
      + 'Suitable for coding work that needs a long autonomous run (refactor, bug fixing, '
      + 'test writing): Cursor runs with full shell and file-write access (--force), '
      + 'works on the given workspace, and reports its own summary. The call blocks until '
      + 'Cursor finishes or the timeout hits; long outputs are truncated with the full log '
      + 'path reported in the result.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The task for Cursor, written as you would tell a coding agent.' },
      workspace: { type: 'string', description: 'Absolute path of the working directory. Defaults to Cursor\'s current directory.' },
      model: { type: 'string', description: 'Cursor model id, e.g. composer-2-fast or gpt-5.2. Defaults to the CLI-configured model.' },
      timeoutMs: { type: 'number', description: 'Override the default timeout (milliseconds).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.prompt.length > 80 ? args.prompt.slice(0, 80) + '…' : args.prompt,
      kind: 'execute',
      rawInput: args.prompt,
    }),
    async execute(args, exec) {
      const timeoutMs = args.timeoutMs ?? config.defaultTimeoutMs
      const commandPath = await resolveCommand(config)
      if (!commandPath) {
        throw new Error(`cursor CLI "${config.command}" not found in PATH; install it with: curl https://cursor.com/install -fsS | bash`)
      }
      const started = Date.now()
      const { code, stdout, stderr, timedOut } =
        await runAgent(buildArgv(commandPath, config, args), { timeoutMs, signal: exec.signal })

      const full = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n')
      let output = full
      let logPath = null
      if (full.length > config.maxOutputChars) {
        logPath = join(tmpdir(), `cursor-bridge-${Date.now()}-${randomBytes(4).toString('hex')}.log`)
        await writeFile(logPath, full, 'utf8')
        output = full.slice(-config.maxOutputChars)
      }

      const parts = []
      if (timedOut) parts.push(`[cursor agent timed out after ${Date.now() - started} ms]`)
      if (code !== null && code !== 0) parts.push(`[exit code: ${code}]`)
      if (output) parts.push(output)
      if (logPath) parts.push(`[output truncated; full log: ${logPath}]`)
      return parts.join('\n')
    },
  }))
}
