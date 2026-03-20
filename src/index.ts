#!/usr/bin/env npx tsx
import { program } from 'commander'
import pc from 'picocolors'
import { scrape } from './scrape.js'
import { queryAllQuestions } from './query.js'
import { provision, getAnswers } from './agentbase.js'
import { judgeResults } from './judge.js'
import { printCliReport, writeJsonReport, writeHtmlReport, ensureOutputDir } from './report.js'
import type { AuditResult } from './types.js'

program
  .name('agent-audit')
  .description('Audit what AI agents get wrong about any product')
  .version('0.3.0')
  .argument('<domain>', 'Domain to audit (e.g., stripe.com)')
  .option('--question <q>', 'Custom question (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--judge <provider>', 'Which provider judges accuracy (openai or anthropic)')
  .option('--output-dir <path>', 'Where to write reports', './audits')
  .option('--pages <path>', 'Extra page path to scrape (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--verbose', 'Debug output', false)
  .action(async (domain: string, opts: {
    question: string[]
    judge?: string
    outputDir: string
    pages: string[]
    verbose: boolean
  }) => {
    const startTime = Date.now()
    const slug = domain.replace(/\./g, '-').toLowerCase()

    console.log(`\n${pc.bold('agent-audit')} v0.3.0 — Auditing ${pc.green(domain)}\n`)

    // Check required env vars
    const agentbaseKey = process.env.AGENTBASE_API_KEY
    if (!agentbaseKey) {
      console.error(pc.red('AGENTBASE_API_KEY not set. Create an account at https://agentbase.to and set the key.'))
      process.exit(1)
    }
    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      console.error(pc.red('No judge API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.'))
      process.exit(1)
    }

    // Step 1: Scrape
    console.log(pc.bold('Step 1: Crawling site...'))
    let groundTruth
    try {
      groundTruth = await scrape(domain, opts.pages, opts.verbose)
    } catch (err) {
      console.error(pc.red(`\nFailed to scrape: ${err instanceof Error ? err.message : err}`))
      process.exit(1)
    }
    console.log(pc.green(`  ${groundTruth.pages.length} pages, ${groundTruth.totalChars.toLocaleString()} chars\n`))

    // Step 2: Provision AgentBase endpoint
    console.log(pc.bold('Step 2: Creating AgentBase endpoint...'))
    try {
      await provision(agentbaseKey, slug, domain, groundTruth.pages, opts.verbose)
    } catch (err) {
      console.error(pc.red(`\nFailed to provision: ${err instanceof Error ? err.message : err}`))
      process.exit(1)
    }
    console.log(pc.green(`  endpoint ready: agentbase.to/a/${slug}\n`))

    // Step 3: Get answers from both sources
    const questions = opts.question
    if (questions.length === 0) {
      console.error(pc.red('No questions provided. Use --question to specify questions.'))
      process.exit(1)
    }

    console.log(pc.bold(`Step 3: Getting answers (AgentBase + ${questions.length} AI agents)...`))

    const [groundTruthAnswers, agentResults] = await Promise.all([
      getAnswers(slug, questions, opts.verbose),
      queryAllQuestions(questions, opts.verbose),
    ])

    const successfulAgents = agentResults.filter(r => !r.answer.startsWith('[ERROR:')).length
    const successfulTruth = groundTruthAnswers.filter(r => !r.answer.startsWith('[ERROR:')).length
    console.log(pc.green(`\n  AgentBase: ${successfulTruth}/${questions.length} answers`))
    console.log(pc.green(`  AI Agents: ${successfulAgents}/${questions.length} answers\n`))

    if (successfulAgents === 0) {
      console.error(pc.red('All agents failed. Check openclaw configuration.'))
      process.exit(1)
    }

    // Step 4: Judge
    console.log(pc.bold('Step 4: Comparing answers...'))
    const questionAudits = await judgeResults(groundTruthAnswers, agentResults, opts.judge ?? null, opts.verbose)

    const counts = questionAudits.reduce((acc, q) => {
      if (q.skipped) acc.skipped++
      else if (q.pass) acc.passed++
      else acc.failed++
      return acc
    }, { passed: 0, failed: 0, skipped: 0 })
    const { passed, failed, skipped: skippedCount } = counts

    const auditResult: AuditResult = {
      domain: groundTruth.domain,
      timestamp: new Date().toISOString(),
      groundTruth: { pages: groundTruth.pages.map(p => ({ url: p.url, chars: p.chars })) },
      questions: questionAudits,
      agentModel: agentResults[0]?.model ?? 'unknown',
      passed,
      failed,
      skipped: skippedCount,
    }

    printCliReport(auditResult)

    ensureOutputDir(opts.outputDir)
    const jsonPath = writeJsonReport(auditResult, opts.outputDir)
    const htmlPath = writeHtmlReport(auditResult, opts.outputDir)

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`\n${pc.bold('Reports saved:')}`)
    console.log(`  ${pc.dim('->')} ${jsonPath}`)
    console.log(`  ${pc.dim('->')} ${htmlPath}`)
    console.log(`\n${pc.bold('Fix what AI agents say about ' + domain + ':')} ${pc.green(`https://agentbase.to/a/${slug}`)}`)
    console.log(pc.dim(`\nCompleted in ${elapsed}s`))
  })

program.parse()
