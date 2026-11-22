import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Point argv[1] at the installed dsh entry so the plugin can resolve the real
// createUserMessage. Set DSH_BIN to override; DSH_BIN=/nonexistent exercises
// the literal fallback.
function detectDshBin() {
  if (process.env.DSH_BIN !== undefined) return process.env.DSH_BIN
  try {
    return realpathSync(execSync('command -v dsh', { shell: '/bin/sh' }).toString().trim())
  } catch {
    return undefined
  }
}
const bin = detectDshBin()
if (bin !== undefined) process.argv[1] = bin

const pluginUrl = new URL('../plugin/index.js', import.meta.url).href
const { apply } = await import(pluginUrl)

const base = Date.now() - 40 * 60_000
const job = (over = {}) => ({
  id: 'bash-abc', kind: 'bash', status: 'running', owner: 's1',
  startedAt: base, output: { total: 128, earliest: 0 }, ...over,
})

function harness(jobsRef, config) {
  const handlers = {}
  const steers = []
  const ctx = {
    on: (event, handler) => { handlers[event] = handler },
    jobs: { list: () => jobsRef.current },
    logger: { warn: (m) => console.log('warn:', m) },
  }
  apply(ctx, config)
  const agent = { session: { id: 's1' }, steer: (m) => steers.push(m) }
  return { handlers, steers, agent }
}

const signal = () => new AbortController().signal
const stop = (h, sig = signal()) => h.handlers['agent/turn-stopping']({ agent: h.agent, signal: sig })

// 1. no live job -> no steer
{
  const h = harness({ current: [] })
  await stop(h)
  assert.equal(h.steers.length, 0)
  console.log('1 ok: idle without jobs is allowed')
}

// 2. owned live job -> steer with id, age, next step
{
  const h = harness({ current: [job()] })
  await stop(h)
  assert.equal(h.steers.length, 1)
  const text = h.steers[0].content[0].text
  assert.match(text, /bash-abc/)
  assert.match(text, /已运行 40 分钟/)
  assert.match(text, /job_output/)
  assert.match(text, /job_kill/)
  console.log('2 ok: owned live job pins the turn open (factory message:',
    Object.isFrozen(h.steers[0]) + ')')
}

// 3. unowned job must NOT pin every session open
{
  const h = harness({ current: [job({ owner: undefined })] })
  await stop(h)
  assert.equal(h.steers.length, 0)
  console.log('3 ok: unowned jobs do not pin turns')
}

// 4. another session's job is ignored
{
  const h = harness({ current: [job({ owner: 'other' })] })
  await stop(h)
  assert.equal(h.steers.length, 0)
  console.log('4 ok: foreign jobs are ignored')
}

// 5. rate limit
{
  const h = harness({ current: [job()] }, { minSteerIntervalMs: 120 })
  await stop(h)
  assert.equal(h.steers.length, 1)
  const pending = stop(h)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(h.steers.length, 1, 'must not steer again immediately')
  await pending
  assert.equal(h.steers.length, 2)
  console.log('5 ok: repeated stops are rate limited')
}

// 6. abort during the hold
{
  const h = harness({ current: [job()] }, { minSteerIntervalMs: 5_000 })
  await stop(h)
  const controller = new AbortController()
  const pending = stop(h, controller.signal)
  controller.abort()
  await pending
  assert.equal(h.steers.length, 1)
  console.log('6 ok: abort escapes the hold')
}

// 7. job settles during the hold
{
  const jobs = { current: [job()] }
  const h = harness(jobs, { minSteerIntervalMs: 120 })
  await stop(h)
  jobs.current = []
  await stop(h)
  assert.equal(h.steers.length, 1)
  console.log('7 ok: a settlement during the hold closes the turn')
}

// 8. kinds filter
{
  const h = harness({ current: [job({ kind: 'subagent' })] }, { kinds: ['bash'] })
  await stop(h)
  assert.equal(h.steers.length, 0)
  console.log('8 ok: kinds filter limits the guard')
}

// 9. a throwing steer must not escape the hook
{
  const h = harness({ current: [job()] })
  h.agent.steer = () => { throw new Error('boom') }
  await stop(h)
  console.log('9 ok: errors are contained')
}

console.log('all checks passed')
