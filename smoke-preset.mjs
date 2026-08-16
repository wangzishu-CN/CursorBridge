// Verify installPreset: apply() with a scratch DSH_HOME must create the
// standard-cursor preset under .agent-presets and register the provider.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import * as plugin from 'file:///D:/ProgramFiles/deepseek-harness/runtime/node_modules/dsh-cursor-bridge/index.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-cursor-preset-'))
process.env.DSH_HOME = scratch

const providers = []
const ctx = {
  logger: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
  subagents: { registerProvider(p) { providers.push(p) } },
  subprocess: {},
}
const config = {
  useWsl: true, command: 'agent', model: '', force: true,
  maxOutputChars: 30000, disposeGraceMs: 3000,
}
await plugin.apply(ctx, config)
await new Promise((r) => setTimeout(r, 300))

const target = join(scratch, '.agent-presets', 'standard-cursor', 'agent.cordis.yml')
console.log('provider registered:', providers.length === 1 ? providers[0].name : 'FAIL')
console.log('preset file exists:', existsSync(target))
console.log('preset path:', target)
// idempotency: apply again, must not throw
await plugin.apply(ctx, config)
console.log('second apply OK')
