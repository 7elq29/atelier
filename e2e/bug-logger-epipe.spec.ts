import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

test('a closed E2E stdout pipe does not create an uncaught main-process EPIPE', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-logger-epipe-'))
  seedE2eConfig(userDataDir)
  let electronApp: ElectronApplication | undefined

  try {
    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: projectRoot
    })
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())

    await electronApp.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __atelierEpipeErrors?: string[]
        __atelierOriginalConsoleLog?: typeof console.log
      }
      scope.__atelierEpipeErrors = []
      process.prependOnceListener('uncaughtException', (error) => {
        scope.__atelierEpipeErrors?.push(
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        )
      })
      scope.__atelierOriginalConsoleLog = console.log
      console.log = () => {
        const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        process.stdout.emit('error', error)
      }
    })

    await page.evaluate(() => {
      window.atelier.log('info', 'e2e stdout pipe closed probe')
    })
    await expect
      .poll(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('e2e stdout pipe closed probe'))
      .toBe(true)
    await page.waitForTimeout(300)

    mkdirSync(artifactsDir, { recursive: true })
    await page.screenshot({ path: join(artifactsDir, 'bug-logger-epipe-trigger.png') })

    const uncaught = await electronApp.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __atelierEpipeErrors?: string[]
        __atelierOriginalConsoleLog?: typeof console.log
      }
      if (scope.__atelierOriginalConsoleLog) console.log = scope.__atelierOriginalConsoleLog
      return scope.__atelierEpipeErrors ?? []
    })
    expect(uncaught).toEqual([])
    await expect.poll(() => page.evaluate(() => window.atelier.getAppVersion())).toMatch(/^\d+\.\d+\.\d+/)
  } finally {
    await electronApp?.close().catch(() => undefined)
  }
})
