/**
 * e2e probe (task 01-harness-abstraction): starts a longer-running prompt
 * and interrupts it mid-stream. Proves the stream ends cleanly (a terminal
 * `interrupted` event, not a crash or hung process).
 *
 * Run via: npm run build && node dist/e2e/run-interrupt-probe.js
 */
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ClaudeAgentSdkHarness } from '../main/harness/claude-agent-sdk-harness'

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const artifactsDir = path.join(repoRoot, 'e2e-artifacts')
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })
  const logPath = path.join(artifactsDir, '01-interrupt.log')

  const cwd = mkdtempSync(path.join(tmpdir(), 'atelier-interrupt-probe-'))
  console.log(`[probe] using scratch cwd: ${cwd}`)

  const harness = new ClaudeAgentSdkHarness()
  const session = await harness.start(
    'Count out loud from 1 to 200, writing one number per line, slowly narrating each one with a short sentence before moving to the next number.',
    { cwd },
  )
  console.log(`[probe] session started: ${session.sessionId}`)

  const lines: string[] = []
  let sawTextDelta = false
  let sawInterrupted = false
  let eventCount = 0
  let interruptSent = false

  const timeoutMs = 60_000
  const start = Date.now()

  for await (const event of session.events) {
    lines.push(JSON.stringify(event))
    eventCount += 1
    if (event.type === 'text_delta') sawTextDelta = true
    if (event.type === 'interrupted') sawInterrupted = true

    // Once we've seen some real streamed text, interrupt mid-turn.
    if (!interruptSent && sawTextDelta) {
      interruptSent = true
      console.log('[probe] sending interrupt() now...')
      await harness.interrupt(session.sessionId)
    }

    if (Date.now() - start > timeoutMs) {
      console.error('[probe] FAIL: timed out waiting for stream to end after interrupt')
      writeFileSync(logPath, lines.join('\n') + '\n')
      process.exitCode = 1
      return
    }
  }

  writeFileSync(logPath, lines.join('\n') + '\n')
  console.log(`[probe] wrote ${lines.length} events (${eventCount} total) to ${logPath}`)
  console.log(`[probe] sawTextDelta=${sawTextDelta} sawInterrupted=${sawInterrupted} interruptSent=${interruptSent}`)

  if (!interruptSent || !sawInterrupted) {
    console.error('[probe] FAIL: expected interrupt-then-clean-terminal-event sequence not observed')
    process.exitCode = 1
    return
  }
  console.log('[probe] PASS: stream ended cleanly after interrupt, process did not hang')
}

main()
  .then(() => {
    // Explicit clean exit: proves no hung handles/process from the aborted query.
    process.exit(process.exitCode ?? 0)
  })
  .catch((err) => {
    console.error('[probe] unhandled error', err)
    process.exit(1)
  })
