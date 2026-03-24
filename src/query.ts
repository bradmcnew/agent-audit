import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

const AGENT_TIMEOUT = 180 // seconds per question

export interface AgentResult {
  question: string
  answer: string
  model: string
}

interface OpenClawOutput {
  payloads?: Array<{ text?: string; mediaUrl?: string | null }>
  meta?: {
    durationMs?: number
    agentMeta?: {
      model?: string
      provider?: string
    }
  }
}

async function queryAgent(
  question: string,
  sessionId: string,
  timeout: number,
  verbose: boolean,
): Promise<AgentResult> {
  const args = [
    'agent',
    '--local',
    '--session-id', sessionId,
    '--message', question,
    '--json',
    '--timeout', String(timeout),
    '--thinking', 'low',
  ]

  if (verbose) console.log(`  spawning agent: "${question.slice(0, 60)}..."`)

  const { stdout } = await exec('openclaw', args, {
    timeout: (timeout + 30) * 1000,
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024, // 10MB — agent output can be large
  })

  // Parse the JSON output — openclaw may prefix with log lines before the JSON
  let jsonStr = stdout
  const jsonStart = stdout.indexOf('{')
  if (jsonStart > 0) jsonStr = stdout.slice(jsonStart)
  const parsed: OpenClawOutput = JSON.parse(jsonStr)

  const answer = parsed.payloads
    ?.map(p => p.text)
    .filter(Boolean)
    .join('\n') ?? ''

  const model = parsed.meta?.agentMeta?.model ?? 'unknown'
  const provider = parsed.meta?.agentMeta?.provider ?? 'openclaw'
  const duration = parsed.meta?.durationMs

  if (verbose && duration) {
    console.log(`  + done (${(duration / 1000).toFixed(1)}s, ${provider}/${model})`)
  }

  return { question, answer, model: `${provider}/${model}` }
}

const MAX_CONCURRENT = 5

export async function queryAllQuestions(
  questions: string[],
  verbose: boolean,
): Promise<AgentResult[]> {
  const baseId = `audit-${Date.now()}`
  if (verbose) console.log(`\n  spawning ${questions.length} agents (max ${MAX_CONCURRENT} concurrent)...`)

  const results: AgentResult[] = new Array(questions.length)
  let next = 0

  async function runNext(): Promise<void> {
    while (next < questions.length) {
      const i = next++
      const q = questions[i]
      results[i] = await queryAgent(q, `${baseId}-q${i}`, AGENT_TIMEOUT, verbose).catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        const shortMsg = msg.slice(0, 200)
        console.error(`  x agent failed: "${q.slice(0, 40)}...": ${shortMsg}`)
        return { question: q, answer: `[ERROR: ${shortMsg}]`, model: 'openclaw-agent' } satisfies AgentResult
      })
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, questions.length) }, () => runNext()))
  return results
}
