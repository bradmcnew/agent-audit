# agent-audit

Audit what AI agents get wrong about any product.

Crawls a company's website, creates a grounded knowledge base via [AgentBase](https://agentbase.to), queries real AI agents, then compares the answers. Surfaces only findings that would make the company say "oh shit" — wrong facts, misrepresented capabilities, harmful framing.

## How it works

```
1. Crawl site         →  scrape product pages via crawl4ai
2. Create endpoint    →  upload to AgentBase as ground truth
3. Query agents       →  ask real AI agents the same questions
4. Judge              →  GPT-5.4 compares answers, flags contradictions
5. Report             →  CLI + JSON + HTML report with pass/fail per question
```

## Install

```bash
git clone https://github.com/bradmcnew/agent-audit.git
cd agent-audit
npm install
```

### Prerequisites

- [crawl4ai](https://github.com/unclecode/crawl4ai) CLI (`crwl`) installed
- [OpenClaw](https://openclaw.com) CLI installed and configured

### Environment variables

```bash
export AGENTBASE_API_KEY="..."   # from https://agentbase.to
export OPENAI_API_KEY="..."      # for the judge model
```

## Usage

```bash
npx tsx src/index.ts resend.com \
  --question "What SMTP ports does Resend support for STARTTLS vs SMTPS?" \
  --question "Can I schedule emails to send at a future time with Resend?" \
  --question "Does Resend support DMARC monitoring or analysis?"
```

Questions are required — you pick what to test. The best questions are specific, verifiable facts buried in docs/pricing pages that agents are likely to get wrong.

### Options

```
--question <q>       Question to test (repeatable, required)
--judge <provider>   Judge provider: openai or anthropic (default: openai)
--output-dir <path>  Report output directory (default: ./audits)
--pages <path>       Extra page paths to crawl (repeatable)
--verbose            Debug output
```

## Output

- **CLI**: pass/fail per question with findings inline
- **JSON**: full structured results in `./audits/`
- **HTML**: self-contained dark-themed report, mobile-friendly

### Finding categories

| Category | Meaning |
|----------|---------|
| **WRONG** | Agent states an incorrect fact — wrong price, wrong capability, wrong limit |
| **MISREPRESENTED** | Agent says the product can't do something it can, or undersells a core feature |
| **HARMFUL** | Agent recommends competitors, questions reliability, or frames the product negatively |

## Example

[See a live audit report for Resend →](https://agentbase.to/audit-resend.html)

## License

MIT
