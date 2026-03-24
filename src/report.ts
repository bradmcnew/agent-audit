import pc from 'picocolors'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AuditResult, QuestionAudit, Finding } from './types.js'

function reportFilename(result: AuditResult, ext: string): string {
  const slug = result.domain.replace(/\./g, '-').toLowerCase()
  const ts = result.timestamp.replace(/[:.]/g, '-').slice(0, 19)
  return `audit-${slug}-${ts}.${ext}`
}

function formatModel(raw: string): string {
  const model = raw.replace(/^(openai|anthropic)\//, '').toUpperCase()
  return `OpenClaw (${model})`
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

// --- CLI report ---

const CATEGORY_ICON: Record<string, string> = {
  wrong: pc.red('x WRONG          '),
  misrepresented: pc.yellow('! MISREPRESENTED '),
  harmful: pc.magenta('!! HARMFUL       '),
}

export function printCliReport(result: AuditResult): void {
  console.log(`\n${pc.bold('=== AUDIT: ' + result.domain + ' ===')}`)
  console.log(pc.dim(`Agent: ${formatModel(result.agentModel)} | ${result.timestamp}\n`))

  for (const qa of result.questions) {
    if (qa.skipped) continue
    if (qa.pass) {
      console.log(pc.green(`  PASS  "${qa.question}"`))
    } else {
      console.log(pc.red(`  FAIL  "${qa.question}"`))
      for (const f of qa.findings) {
        console.log(`        ${CATEGORY_ICON[f.category] ?? f.category} ${f.why_this_matters}`)
        console.log(pc.dim(`          Agent said: ${truncate(f.what_agent_said, 100)}`))
        console.log(pc.dim(`          Actually:   ${truncate(f.what_is_actually_true, 100)}`))
      }
    }
    console.log()
  }

  const totalQuestions = result.passed + result.failed + result.skipped
  console.log(pc.bold(`${result.failed} issues out of ${totalQuestions} questions (${result.skipped} skipped)`))
}

// --- JSON ---

export function ensureOutputDir(dir: string): void { mkdirSync(dir, { recursive: true }) }

export function writeJsonReport(result: AuditResult, dir: string): string {
  const path = join(dir, reportFilename(result, 'json'))
  writeFileSync(path, JSON.stringify(result, null, 2))
  return path
}

// --- HTML ---

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const CATEGORY_COLOR: Record<string, string> = { wrong: 'var(--red)', misrepresented: 'var(--yellow)', harmful: 'var(--purple)' }

function findingHtml(f: Finding): string {
  const color = CATEGORY_COLOR[f.category] ?? 'var(--muted)'
  return `
    <div class="finding" style="border-left:3px solid ${color}">
      <div class="cat" style="color:${color}">${f.category.toUpperCase()}</div>
      <div class="why">${esc(f.why_this_matters)}</div>
      <div class="detail">
        <div><strong>Agent said:</strong> ${esc(truncate(f.what_agent_said, 200))}</div>
        <div><strong>Actually:</strong> ${esc(truncate(f.what_is_actually_true, 200))}</div>
      </div>
    </div>`
}

function questionHtml(qa: QuestionAudit): string {
  return `
    <div class="fail-card">
      <div class="fail-header">
        <span class="label">FAIL</span>
        <span class="question">${esc(qa.question)}</span>
      </div>
      <div class="answers">
        <div class="answer-box truth">
          <div class="source">AGENTBASE</div>
          <div class="text">${esc(truncate(qa.agentbaseAnswer, 250))}</div>
        </div>
        <div class="answer-box agent">
          <div class="source">AGENT</div>
          <div class="text">${esc(truncate(qa.agentAnswer, 250))}</div>
        </div>
      </div>
      ${qa.findings.map(findingHtml).join('')}
    </div>`
}

export function writeHtmlReport(result: AuditResult, dir: string): string {
  const path = join(dir, reportFilename(result, 'html'))
  const slug = result.domain.replace(/\./g, '-').toLowerCase()
  const totalFindings = result.questions.reduce((n, q) => n + q.findings.length, 0)
  const totalQuestions = result.passed + result.failed + result.skipped

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent Audit: ${esc(result.domain)}</title>
  <meta name="description" content="Agents are getting ${result.failed} thing${result.failed === 1 ? '' : 's'} wrong about ${esc(result.domain)}">
  <meta property="og:title" content="Agent Audit: ${esc(result.domain)}">
  <meta property="og:description" content="Agents are getting ${result.failed} thing${result.failed === 1 ? '' : 's'} wrong about ${esc(result.domain)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://agentbase.to/audit/${esc(slug)}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Agent Audit: ${esc(result.domain)}">
  <meta name="twitter:description" content="Agents are getting ${result.failed} thing${result.failed === 1 ? '' : 's'} wrong about ${esc(result.domain)}">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#09090b; --fg:#fafafa; --border:#1e1e23; --surface:#060608; --surface-alt:#0d0d12; --muted:#9f9fa9; --fg-dim:#ccc; --green:#9ece6a; --red:#f7768e; --yellow:#e0af68; --purple:#bb9af7 }
    * { margin:0; padding:0; box-sizing:border-box }
    body { background:var(--bg); color:var(--fg); font-family:Inter,system-ui,sans-serif; line-height:1.6; padding:1.5rem; max-width:900px; margin:0 auto }
    h1 { font-family:'JetBrains Mono',monospace; font-size:1.5rem; word-break:break-word }
    a { color:var(--green); text-decoration:none }
    .header { margin-bottom:2rem }
    .scores { display:flex; gap:1.5rem; margin:1rem 0; font-family:'JetBrains Mono',monospace; flex-wrap:wrap }
    .scores .passed { color:var(--green); font-size:1.5rem; font-weight:700 }
    .scores .failed { font-size:1.5rem; font-weight:700 }
    .meta { color:var(--muted); font-size:0.8em; line-height:1.8 }
    .pass-row { margin:0.5rem 0; padding:0.75rem 1rem; border:1px solid var(--border); display:flex; align-items:baseline; gap:0.75rem }
    .pass-row .label { color:var(--green); font-weight:600; font-size:0.85em; flex-shrink:0 }
    .pass-row .question { font-family:'JetBrains Mono',monospace; font-size:0.9rem; word-break:break-word }
    .fail-card { margin:1rem 0; padding:1.25rem; border:1px solid var(--border); background:var(--surface) }
    .fail-header { margin-bottom:1rem; word-break:break-word; display:flex; align-items:baseline; gap:0.75rem }
    .fail-header .label { color:var(--red); font-weight:600; flex-shrink:0 }
    .fail-header .question { font-family:'JetBrains Mono',monospace; font-size:0.95rem }
    .answers { display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; margin-bottom:1rem; font-size:0.8em }
    .answer-box { padding:0.75rem; border:1px solid var(--border); min-width:0 }
    .answer-box .source { font-weight:600; font-size:0.8em; margin-bottom:0.25rem }
    .answer-box.truth .source { color:var(--green) }
    .answer-box.agent .source { color:var(--yellow) }
    .answer-box .text { color:var(--fg-dim); word-break:break-word }
    .finding { margin-bottom:0.75rem; padding:1rem; background:var(--surface-alt) }
    .finding:last-child { margin-bottom:0 }
    .finding .cat { font-weight:600; font-size:0.85em; margin-bottom:0.5rem }
    .finding .why { margin-bottom:0.5rem }
    .finding .detail { font-size:0.85em; color:var(--muted) }
    .finding .detail div { margin-top:0.25rem }
    .footer { margin-top:2rem; padding-top:1rem; border-top:1px solid var(--border); color:var(--muted); font-size:0.8rem; line-height:1.8 }
    @media (max-width:600px) {
      body { padding:0.75rem }
      h1 { font-size:1.2rem }
      .scores { gap:0.75rem }
      .scores .passed, .scores .failed { font-size:1.2rem }
      .pass-row { padding:0.6rem 0.75rem }
      .pass-row .question { font-size:0.8rem }
      .fail-card { padding:1rem }
      .fail-header .question { font-size:0.85rem }
      .answers { grid-template-columns:1fr; gap:0.5rem }
      .finding { padding:0.75rem }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Agent Audit: ${esc(result.domain)}</h1>
    <div class="scores">
      <span class="passed">${result.passed} passed</span>
      <span class="failed" style="color:${result.failed > 0 ? 'var(--red)' : 'var(--muted)'}">${result.failed} failed</span>
    </div>
    <p class="meta">${totalFindings} issues across ${totalQuestions} questions &middot; Agent: ${esc(formatModel(result.agentModel))}</p>
    <p class="meta">Ground truth: ${result.groundTruth.pages.length} pages (${result.groundTruth.pages.reduce((s, p) => s + p.chars, 0).toLocaleString()} chars)</p>
  </div>

  ${result.questions.filter(q => !q.skipped).map(qa => qa.pass
    ? `<div class="pass-row"><span class="label">PASS</span><span class="question">${esc(qa.question)}</span></div>`
    : questionHtml(qa)
  ).join('\n')}

  <div class="footer">
    Generated by <a href="https://github.com/bradmcnew/agent-audit">agent-audit</a><br>
    Is this your company? <a href="https://agentbase.to/a/${esc(slug)}">Claim your agent endpoint &rarr;</a>
  </div>
</body>
</html>`

  writeFileSync(path, html)
  return path
}
