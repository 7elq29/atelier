import { app } from 'electron'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts: string
  level: LogLevel
  process: 'main' | 'renderer'
  msg: string
  [key: string]: unknown
}

let stream: WriteStream | undefined
let logFilePath: string | undefined

/**
 * Resolves the log file path under the app's user-data dir and lazily opens
 * an append-mode write stream to it. Safe to call multiple times.
 *
 * Falls back to a scratch dir under the OS tmpdir when `app` isn't actually
 * running inside Electron (`app.getPath` throws/is unavailable) — this
 * logger is also exercised directly by the standalone probe scripts under
 * `src/e2e/` (run via plain `node`, not `electron .`; see
 * `run-interrupt-probe.ts`). 04-composer-core added the first `logger.info()`
 * calls reachable from a purely-local probe run
 * (`ClaudeAgentSdkHarness.interrupt()`/`streamInput()`), which surfaced this
 * gap for real (`app.getPath` throws "Cannot read properties of undefined"
 * outside Electron).
 */
function getStream(): WriteStream {
  if (!stream) {
    let logsDir: string
    try {
      logsDir = join(app.getPath('userData'), 'logs')
    } catch {
      logsDir = join(tmpdir(), 'atelier-standalone-logs')
    }
    mkdirSync(logsDir, { recursive: true })
    logFilePath = join(logsDir, 'main.log')
    stream = createWriteStream(logFilePath, { flags: 'a' })
  }
  return stream
}

export function getLogFilePath(): string {
  if (!logFilePath) {
    // Ensure the stream (and therefore the path) has been initialized.
    getStream()
  }
  return logFilePath as string
}

function write(entry: LogEntry): void {
  const line = JSON.stringify(entry)
  getStream().write(line + '\n')
  // Mirror to stdout for `npm run dev` visibility.
  // eslint-disable-next-line no-console
  console.log(line)
}

function makeLogger(processName: 'main' | 'renderer') {
  return {
    debug: (msg: string, extra?: Record<string, unknown>) =>
      write({ ts: new Date().toISOString(), level: 'debug', process: processName, msg, ...extra }),
    info: (msg: string, extra?: Record<string, unknown>) =>
      write({ ts: new Date().toISOString(), level: 'info', process: processName, msg, ...extra }),
    warn: (msg: string, extra?: Record<string, unknown>) =>
      write({ ts: new Date().toISOString(), level: 'warn', process: processName, msg, ...extra }),
    error: (msg: string, extra?: Record<string, unknown>) =>
      write({ ts: new Date().toISOString(), level: 'error', process: processName, msg, ...extra })
  }
}

export const logger = makeLogger('main')
export const rendererLogger = makeLogger('renderer')
