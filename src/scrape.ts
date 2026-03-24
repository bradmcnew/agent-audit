import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ScrapedPage, GroundTruth } from './types.js'

const exec = promisify(execFile)

const CRAWL_TIMEOUT = 180_000 // 3 min for full site crawl
const MAX_PAGES = 30
const MAX_PAGE_CHARS = 30_000

export async function scrape(domain: string, extraPages: string[], verbose: boolean): Promise<GroundTruth> {
  const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`
  const cleanDomain = new URL(baseUrl).hostname

  if (verbose) console.log(`\nCrawling ${cleanDomain} with crawl4ai...`)

  let stdout = ''
  try {
    const result = await exec('crwl', [
      baseUrl,
      '--deep-crawl', 'bfs',
      '--max-pages', String(MAX_PAGES),
      '-o', 'markdown',
    ], {
      timeout: CRAWL_TIMEOUT,
      maxBuffer: 50 * 1024 * 1024,
    })
    stdout = result.stdout
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      throw new Error('crawl4ai not installed. Run: pip install -U crawl4ai && crawl4ai-setup')
    }
    // If extra pages are specified, fall back to crawling those individually
    if (extraPages.length > 0) {
      if (verbose) console.log(`  main crawl failed, falling back to extra pages...`)
    } else {
      throw err
    }
  }

  // Parse separator-delimited output:
  // ============================================================
  // # https://example.com/page
  // ============================================================
  // (page content in markdown)
  const pages: ScrapedPage[] = []
  const sections = stdout.split(/={60,}\n# (https?:\/\/[^\n]+)\n={60,}/)

  // sections alternates: [preamble, url1, content1, url2, content2, ...]
  for (let i = 1; i < sections.length; i += 2) {
    const url = sections[i].trim()
    const content = sections[i + 1]?.trim() ?? ''
    if (content.length < 50) continue

    const trimmed = content.slice(0, MAX_PAGE_CHARS)
    let pathname: string
    try {
      pathname = new URL(url).pathname
    } catch {
      pathname = url
    }

    pages.push({ url, title: pathname, content: trimmed, chars: trimmed.length })
    if (verbose) console.log(`  + ${pathname} (${trimmed.length} chars)`)
  }

  // If no sections parsed (single page or different format), use raw output
  if (pages.length === 0 && stdout.trim().length > 50) {
    const trimmed = stdout.trim().slice(0, MAX_PAGE_CHARS)
    pages.push({ url: baseUrl, title: '/', content: trimmed, chars: trimmed.length })
    if (verbose) console.log(`  + / (${trimmed.length} chars, raw output)`)
  }

  // Scrape extra pages individually
  for (const path of extraPages) {
    const pageUrl = `${baseUrl}${path}`
    if (pages.some(p => p.url === pageUrl)) continue

    try {
      if (verbose) console.log(`  crawling extra: ${path}...`)
      const result = await exec('crwl', [pageUrl, '-o', 'markdown'], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      const content = result.stdout.trim()
      if (content.length > 50) {
        const trimmed = content.slice(0, MAX_PAGE_CHARS)
        pages.push({ url: pageUrl, title: path, content: trimmed, chars: trimmed.length })
        if (verbose) console.log(`  + ${path} (${trimmed.length} chars)`)
      }
    } catch {
      if (verbose) console.log(`  x ${path} (failed)`)
    }
  }

  if (pages.length === 0) {
    throw new Error(`Could not scrape any content from ${cleanDomain}.`)
  }

  // Kill any lingering chromium processes from crawl4ai to free memory before agents run
  try {
    await exec('pkill', ['-f', 'chromium|chrome-headless'], { timeout: 5000 }).catch(() => {})
  } catch { /* ignore */ }

  const totalChars = pages.reduce((sum, p) => sum + p.chars, 0)
  if (verbose) console.log(`  ${pages.length} pages, ${totalChars.toLocaleString()} chars total`)

  return { domain: cleanDomain, pages, totalChars }
}
