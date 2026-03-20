import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { zodResponseFormat } from 'openai/helpers/zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { JudgeResponseSchema } from './types.js'
import type { JudgeResponse, QuestionAudit } from './types.js'
import type { AgentResult } from './query.js'
import type { GroundTruthAnswer } from './agentbase.js'

const JUDGE_SYSTEM_PROMPT = `You are evaluating whether an AI agent's answer about a product would concern the company that makes it.

Answer A is the ground truth — from an AgentBase endpoint grounded in the company's actual website.
Answer B is from an AI agent that researched the product independently.

Your job: decide if Answer B has any DEAL-BREAKER issues the company would urgently want to know about.

Return pass=true if the agent's answer is acceptable. Both answers don't need to be identical — different wording, different level of detail, or different emphasis is FINE. A correct but less detailed answer is a PASS.

Return pass=false ONLY if Answer B has issues in these categories:

- "wrong": The agent states a FACT that is INCORRECT or outdated. Wrong price, wrong limit, stale information. A customer would act on this and be misled.

- "misrepresented": The agent says the product CAN'T do something it CAN, or frames a core capability as minor/nonexistent. Example: saying "Resend doesn't really do marketing email" when it has a full broadcasts feature. This loses the company potential customers.

- "harmful": The agent recommends competitors, questions reliability, frames the product negatively, or says something the company would hate customers seeing.

CRITICAL RULES:
- Only flag things where the agent CONTRADICTS AgentBase, not where the agent has MORE info. If the agent adds a detail that AgentBase doesn't mention, that is NOT wrong — the agent may have found correct info that AgentBase missed. Only flag if AgentBase explicitly states a DIFFERENT value.
- If both answers reasonably address the question, return pass=true with empty findings.
- A less detailed answer is NOT a finding. Only factual errors and misrepresentations count.
- If the question asks about limitations, drawbacks, or criticism, the agent is EXPECTED to be negative. Negative framing in response to a negative question is not "harmful" — it's answering correctly.
- When in doubt, PASS. Only fail on things that would make the company say "oh shit."
- Maximum 3 findings per question. Quality over quantity.`

// --- Judge via OpenAI ---

async function judgeWithOpenAI(
  client: OpenAI,
  question: string,
  groundTruth: string,
  agentAnswer: string,
): Promise<JudgeResponse> {
  const res = await client.beta.chat.completions.parse({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `## Question\n${question}\n\n## Answer A (Ground Truth)\n${groundTruth}\n\n## Answer B (AI Agent)\n${agentAnswer}`,
      },
    ],
    response_format: zodResponseFormat(JudgeResponseSchema, 'audit_result'),
    max_completion_tokens: 1024,
  })
  const parsed = res.choices[0]?.message?.parsed
  if (!parsed) throw new Error('Judge returned no structured output')
  return parsed
}

// --- Judge via Anthropic ---

const JUDGE_JSON_SCHEMA = zodToJsonSchema(JudgeResponseSchema, { target: 'openApi3' })

async function judgeWithAnthropic(
  client: Anthropic,
  question: string,
  groundTruth: string,
  agentAnswer: string,
): Promise<JudgeResponse> {
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `## Question\n${question}\n\n## Answer A (Ground Truth)\n${groundTruth}\n\n## Answer B (AI Agent)\n${agentAnswer}\n\nUse the audit_result tool.`,
    }],
    tools: [{
      name: 'audit_result',
      description: 'Return pass/fail and any deal-breaker findings',
      input_schema: JUDGE_JSON_SCHEMA as Anthropic.Tool.InputSchema,
    }],
    tool_choice: { type: 'tool' as const, name: 'audit_result' },
  })
  const toolBlock = res.content.find(b => b.type === 'tool_use')
  if (!toolBlock || toolBlock.type !== 'tool_use') throw new Error('Judge returned no tool use')
  return JudgeResponseSchema.parse(toolBlock.input)
}

// --- Check if answer is effectively empty ---

function isEmptyAnswer(answer: string): boolean {
  const lower = answer.toLowerCase().trim()
  return (
    lower.startsWith('[error:') ||
    lower.includes('not in knowledge base') ||
    lower.includes('no relevant documents found') ||
    lower.length < 20
  )
}

// --- Main judge ---

export async function judgeResults(
  groundTruthAnswers: GroundTruthAnswer[],
  agentResults: AgentResult[],
  judgeProvider: string | null,
  verbose: boolean,
): Promise<QuestionAudit[]> {
  const openaiKey = process.env.OPENAI_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  const resolvedProvider = judgeProvider ?? (openaiKey ? 'openai' : anthropicKey ? 'anthropic' : null)
  if (!resolvedProvider) throw new Error('No judge API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.')

  const key = resolvedProvider === 'anthropic' ? anthropicKey : openaiKey
  if (!key) throw new Error(`No API key for judge provider "${resolvedProvider}".`)

  let judgeFn: (q: string, truth: string, agent: string) => Promise<JudgeResponse>
  if (resolvedProvider === 'anthropic') {
    const client = new Anthropic({ apiKey: key })
    judgeFn = (q, t, a) => judgeWithAnthropic(client, q, t, a)
  } else {
    const client = new OpenAI({ apiKey: key })
    judgeFn = (q, t, a) => judgeWithOpenAI(client, q, t, a)
  }

  if (verbose) console.log(`  judge: ${resolvedProvider}`)

  const truthMap = new Map(groundTruthAnswers.map(a => [a.question, a.answer]))
  const agentMap = new Map(agentResults.map(a => [a.question, a.answer]))

  return Promise.all(
    groundTruthAnswers.map(async ({ question }): Promise<QuestionAudit> => {
      const agentbaseAnswer = truthMap.get(question) ?? ''
      const agentAnswer = agentMap.get(question) ?? ''

      // Skip if either side has no useful answer
      if (isEmptyAnswer(agentbaseAnswer) || isEmptyAnswer(agentAnswer)) {
        if (verbose) console.log(`  skip: "${question.slice(0, 50)}..."`)
        return { question, agentbaseAnswer, agentAnswer, skipped: true, pass: true, findings: [] }
      }

      if (verbose) console.log(`  judge: "${question.slice(0, 50)}..."`)

      try {
        const result = await judgeFn(question, agentbaseAnswer, agentAnswer)
        return {
          question,
          agentbaseAnswer,
          agentAnswer,
          skipped: false,
          pass: result.pass,
          findings: result.findings,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  x judge error: "${question.slice(0, 40)}": ${msg}`)
        return { question, agentbaseAnswer, agentAnswer, skipped: true, pass: true, findings: [] }
      }
    })
  )
}
