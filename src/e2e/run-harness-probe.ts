/**
 * e2e probe (task 01-harness-abstraction): a real, non-mocked call through
 * the harness abstraction. Proves:
 *   1. Token-level streaming works (at least one text_delta event).
 *   2. A terminal `result` event arrives with non-empty usage data.
 *   3. The SDK actually routed through ANTHROPIC_BASE_URL=
 *      https://genai-api.uberinternal.com (auth inheritance, not assumed).
 *
 * Run via: npm run build && node dist/e2e/run-harness-probe.js
 */
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ClaudeAgentSdkHarness } from '../main/harness/claude-agent-sdk-harness'
import type { HarnessEvent } from '../main/harness/types'

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const artifactsDir = path.join(repoRoot, 'e2e-artifacts')
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })
  const logPath = path.join(artifactsDir, '01-stream.log')

  const resolvedBaseUrl = process.env.ANTHROPIC_BASE_URL
  console.log(`[probe] process.env.ANTHROPIC_BASE_URL = ${resolvedBaseUrl ?? '(unset)'}`)
  if (resolvedBaseUrl !== 'https://genai-api.uberinternal.com') {
    console.error(
      '[probe] FAIL: ANTHROPIC_BASE_URL is not set to the expected Uber gateway in this shell. ' +
        'The harness inherits process.env verbatim (see claude-agent-sdk-harness.ts), so whatever ' +
        'is printed above is exactly what the SDK subprocess will see.',
    )
    process.exitCode = 1
  }

  const cwd = mkdtempSync(path.join(tmpdir(), 'gardenia-harness-probe-'))
  console.log(`[probe] using scratch cwd: ${cwd}`)

  const harness = new ClaudeAgentSdkHarness()
  const session = await harness.start('Reply with exactly the word PONG and nothing else.', { cwd })
  console.log(`[probe] session started: ${session.sessionId}`)

  const lines: string[] = []
  let sawTextDelta = false
  let sawResultWithUsage = false
  let resolvedModel: string | undefined
  let sourcedApiKeyFrom: string | undefined

  for await (const event of session.events) {
    lines.push(JSON.stringify(event))
    logEventSummary(event)
    if (event.type === 'session_started') {
      resolvedModel = event.model
      sourcedApiKeyFrom = event.apiKeySource
    }
    if (event.type === 'text_delta' && event.text.length > 0) {
      sawTextDelta = true
    }
    if (event.type === 'result' && event.usage && Object.keys(event.usage as object).length > 0) {
      sawResultWithUsage = true
    }
  }

  writeFileSync(logPath, lines.join('\n') + '\n')
  console.log(`[probe] wrote ${lines.length} events to ${logPath}`)
  console.log(`[probe] resolved model: ${resolvedModel ?? '(unknown)'}`)
  console.log(`[probe] apiKeySource reported by SDK init message: ${sourcedApiKeyFrom ?? '(unknown)'}`)

  console.log(`[probe] sawTextDelta=${sawTextDelta} sawResultWithUsage=${sawResultWithUsage}`)
  if (!sawTextDelta || !sawResultWithUsage) {
    console.error('[probe] FAIL: expected assertions not met')
    process.exitCode = 1
    return
  }
  console.log('[probe] PASS')
}

function logEventSummary(event: HarnessEvent): void {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.text)
      break
    case 'result':
      console.log(
        `\n[probe] result: subtype=${event.subtype} isError=${event.isError} usage=${JSON.stringify(event.usage)}`,
      )
      break
    default:
      console.log(`[probe] event: ${event.type}`)
  }
}

main().catch((err) => {
  console.error('[probe] unhandled error', err)
  process.exitCode = 1
})
