/**
 * turn-keepalive: refuse to let a turn close while background jobs are still
 * running. The model keeps getting steps, so it can read the job, judge it
 * stuck, and call job_kill — instead of going idle and waiting for a
 * settlement that may never come.
 *
 * Config: minSteerIntervalMs (default 120000), kinds (default: every kind).
 */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'turn-keepalive'
export const inject = ['jobs']

const MAX_HOLD_MS = 120_000

const isLive = (job) => job.status === 'running' || job.status === 'stopping'

/**
 * The installed DSH's own message factory, so a steer message always matches
 * the running version's shape. Resolved from the dsh entry script; the manual
 * literal below is only the fallback when that resolution fails.
 */
const userMessageFactory = (async () => {
  try {
    const entry = process.argv[1]
    if (entry === undefined) return undefined
    const require = createRequire(realpathSync(entry))
    const module = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
    return typeof module.createUserMessage === 'function' ? module.createUserMessage : undefined
  } catch {
    return undefined
  }
})()

async function userMessage(content, source) {
  const factory = await userMessageFactory
  if (factory !== undefined) return factory({ content, source })
  return { id: randomUUID(), role: 'user', content, source }
}

/**
 * Keep turns open while owned jobs are live.
 * @param ctx - plugin context carrying the job registry.
 * @param config - thresholds; all optional.
 */
export function apply(ctx, config = {}) {
  const minInterval = positive(config.minSteerIntervalMs, 120_000)
  const kinds = Array.isArray(config.kinds) && config.kinds.length > 0
    ? new Set(config.kinds)
    : undefined
  const lastSteer = new WeakMap()

  // Only jobs this agent owns: `list()` also returns unowned jobs, and those
  // must never pin every session's turn open.
  const liveJobs = (agent) => ctx.jobs.list(agent.session.id)
    .filter((job) => job.owner === agent.session.id && isLive(job)
      && (kinds === undefined || kinds.has(job.kind)))

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    try {
      if (signal.aborted || liveJobs(agent).length === 0) return

      // Rate limit: one steer per agent per interval, so a model that answers
      // instantly cannot spin this hook at full speed.
      const remaining = (lastSteer.get(agent) ?? 0) + minInterval - Date.now()
      if (remaining > 0) {
        await hold(remaining, signal)
        if (signal.aborted) return
      }

      // The wait may have outlived the job (or the user stopped it).
      const jobs = liveJobs(agent)
      if (jobs.length === 0) return

      const now = Date.now()
      const lines = jobs.map((job) => {
        const ran = Math.max(0, Math.round((now - job.startedAt) / 60_000))
        const progress = job.progress === undefined ? '' : `，进度 ${job.progress}`
        return `- ${job.id}（${job.kind}，已运行 ${ran} 分钟${progress}）`
      })
      lastSteer.set(agent, now)

      agent.steer(await userMessage([{
        type: 'text',
        text: [
          `回合不能结束：还有 ${jobs.length} 个后台任务未结算。`,
          ...lines,
          '用 job_output(job_id, wait: true, timeout_ms: 120000) 继续观察；期间可以处理其它独立工作。',
          '若长时间没有新输出或确认进程卡死，用 job_kill 停掉它，不要一直空等。',
        ].join('\n'),
      }], { kind: 'turn-keepalive' }))
    } catch (error) {
      // A guard must never be the reason a turn breaks.
      ctx.logger?.warn?.(`turn-keepalive: ${String(error)}`)
    }
  })
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Wait, but wake early on abort; never hold the turn longer than MAX_HOLD_MS in one go. */
function hold(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, Math.min(ms, MAX_HOLD_MS))
    signal.addEventListener('abort', done, { once: true })
  })
}
