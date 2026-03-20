import type { ScrapedPage } from './types.js'

function baseUrl(): string {
  return process.env.AGENTBASE_URL || 'https://agentbase.to'
}

interface ApiError {
  error?: { code: string; message: string }
}

async function authedPost(path: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function createEndpoint(apiKey: string, slug: string, name: string, description: string): Promise<{ created: boolean }> {
  const res = await authedPost('/v1/endpoints', apiKey, { slug, name, description, mode: 'platform' })
  if (res.status === 409) return { created: false }
  if (!res.ok) {
    const data = await res.json() as ApiError
    throw new Error(`Failed to create endpoint: ${data.error?.message ?? res.statusText}`)
  }
  return { created: true }
}

export async function uploadDoc(apiKey: string, slug: string, content: string, filename: string): Promise<void> {
  const res = await authedPost(`/v1/endpoints/${slug}/docs`, apiKey, { content, filename })
  if (!res.ok) {
    const data = await res.json() as ApiError
    throw new Error(`Upload failed for ${filename}: ${data.error?.message ?? res.statusText}`)
  }
}

export async function queryEndpoint(slug: string, query: string): Promise<string> {
  const res = await fetch(`${baseUrl()}/a/${slug}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, max_sources: 5 }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Query failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = await res.json() as { answer?: string }
  return data.answer ?? ''
}

export async function provision(
  apiKey: string,
  slug: string,
  domain: string,
  pages: ScrapedPage[],
  verbose: boolean,
): Promise<void> {
  // Create endpoint (skip if exists)
  const { created } = await createEndpoint(apiKey, slug, domain, `Agent representative for ${domain}`)
  if (verbose) console.log(created ? `  created endpoint: ${slug}` : `  endpoint ${slug} already exists`)

  // Upload each page as a doc (serial to avoid overwhelming the API)
  for (const page of pages) {
    // Sanitize filename: replace slashes, limit length
    const filename = (page.title.replace(/\//g, '_').replace(/^_/, '') || 'page') + '.md'
    try {
      await uploadDoc(apiKey, slug, page.content, filename)
      if (verbose) console.log(`  uploaded: ${filename} (${page.chars} chars)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (verbose) console.log(`  x upload failed: ${filename}: ${msg}`)
    }
  }
}

export interface GroundTruthAnswer {
  question: string
  answer: string
}

export async function getAnswers(
  slug: string,
  questions: string[],
  verbose: boolean,
): Promise<GroundTruthAnswer[]> {
  // Query all questions in parallel (within rate limits — 7 is fine)
  const results = await Promise.all(
    questions.map(async (question) => {
      try {
        const answer = await queryEndpoint(slug, question)
        if (verbose) console.log(`  + AgentBase: "${question.slice(0, 50)}..."`)
        return { question, answer }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (verbose) console.log(`  x AgentBase failed: "${question.slice(0, 40)}...": ${msg}`)
        return { question, answer: `[ERROR: ${msg}]` }
      }
    })
  )
  return results
}
