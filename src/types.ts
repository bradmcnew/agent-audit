import { z } from 'zod'

// --- Finding categories ---

export const CATEGORIES = ['wrong', 'misrepresented', 'harmful'] as const

export const FindingSchema = z.object({
  category: z.enum(CATEGORIES),
  what_agent_said: z.string().describe('The specific claim or framing the agent used'),
  what_is_actually_true: z.string().describe('The correct information from the ground truth'),
  why_this_matters: z.string().describe('Why the company would care about this — how it hurts them'),
})

export const JudgeResponseSchema = z.object({
  pass: z.boolean().describe('true if the agent answer is acceptable, false if there are deal-breaker issues'),
  findings: z.array(FindingSchema).describe('Only include findings if pass is false'),
})

export type Finding = z.infer<typeof FindingSchema>
export type JudgeResponse = z.infer<typeof JudgeResponseSchema>

// --- Scrape types ---

export interface ScrapedPage {
  url: string
  title: string
  content: string
  chars: number
}

export interface GroundTruth {
  domain: string
  pages: ScrapedPage[]
  totalChars: number
}

// --- Audit result (structured by question) ---

export interface QuestionAudit {
  question: string
  agentbaseAnswer: string
  agentAnswer: string
  skipped: boolean
  pass: boolean
  findings: Finding[]
}

export interface AuditResult {
  domain: string
  timestamp: string
  groundTruth: { pages: { url: string; chars: number }[] }
  questions: QuestionAudit[]
  agentModel: string
  passed: number
  failed: number
  skipped: number
}

