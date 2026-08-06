import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const panelsLogPath = join(artifactsDir, '07-panels.log')

mkdirSync(artifactsDir, { recursive: true })
writeFileSync(panelsLogPath, '')

function log(line: string): void {
  writeFileSync(panelsLogPath, `${line}\n`, { flag: 'a' })
}

function configPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config.json')
}

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(configPath(userDataDir), JSON.stringify({ onboardingCompleted: true }))
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function stubProjectFolder(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folderPath] })) as typeof dialog.showOpenDialog
  }, path)
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** Real throwaway git fixture repo: two commits, then an uncommitted change, for a real diff/commit/worktree round-trip. */
function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-panels-repo-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'e2e@example.com'])
  git(dir, ['config', 'user.name', 'E2E Test'])
  writeFileSync(join(dir, 'README.md'), '# fixture repo\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\nfunction hello() {\n  return 'hi'\n}\n")
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'Initial commit'])

  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\nfunction hello() {\n  return 'hello world'\n}\n")
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'Change greeting (see https://example.com/gardenia-e2e-external-link-check)'])

  // Real uncommitted change so the Diff tab has something live to show.
  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\nfunction hello() {\n  return 'hello world!'\n}\n\nmodule.exports = { hello }\n")

  // A real image (tiny 1x1 PNG) and a real HTML file for the Files-panel preview tests.
  const onePxPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )
  writeFileSync(join(dir, 'logo.png'), onePxPng)
  writeFileSync(join(dir, 'page.html'), '<html><body><h1>Fixture page</h1><a href="https://example.com">a link</a></body></html>')

  return dir
}

function connectTcp(port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout waiting for forwarded port data'))
    }, timeoutMs)
    socket.once('data', (chunk) => {
      clearTimeout(timer)
      socket.end()
      resolve(chunk)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('07-secondary-panels', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let repoDir: string
  let sessionId: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-panels-'))
    seedSkipOnboarding(userDataDir)
    repoDir = buildFixtureRepo()
    log(`fixture repo created at ${repoDir}`)
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── Setup: a real local claude-code session on the fixture repo ────────
  test('setup: create a claude-code session on the fixture repo', async () => {
    await stubProjectFolder(electronApp, repoDir)
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect(page.getByTestId('tab-strip')).toBeVisible()
  })

  // ── 1. Tab bar: switching hides/shows via class, doesn't unmount ───────
  test('tab bar: switches Chat/Diff/Files/Terminal via hidden-class toggle', async () => {
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)
    await expect(page.locator('.tab-content[data-tab="chat"]')).not.toHaveClass(/hidden/)
    await expect(page.locator('.tab-content[data-tab="diff"]')).toHaveClass(/hidden/)

    await page.getByTestId('tab-diff').click()
    await expect(page.getByTestId('tab-diff')).toHaveClass(/active/)
    await expect(page.locator('.tab-content[data-tab="diff"]')).not.toHaveClass(/hidden/)
    await expect(page.locator('.tab-content[data-tab="chat"]')).toHaveClass(/hidden/)

    await page.screenshot({ path: join(artifactsDir, '07-tabbar.png') })
    await page.getByTestId('tab-chat').click()

    // Both themes, per e2e-test-plan.md's UI-match requirement, at minimum for the tab bar.
    await page.getByTestId('open-settings-button').click()
    await page.getByTestId('theme-light-btn').click()
    await page.getByTestId('settings-close').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    await page.screenshot({ path: join(artifactsDir, '07-tabbar-light.png') })

    await page.getByTestId('open-settings-button').click()
    await page.getByTestId('theme-dark-btn').click()
    await page.getByTestId('settings-close').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.screenshot({ path: join(artifactsDir, '07-tabbar-dark.png') })
  })

  // ── 2. Diff panel: real hunks + commits, inline comment -> composer ────
  test('diff panel: shows real uncommitted diff + commit log, inline comment feeds the composer', async () => {
    await page.getByTestId('tab-diff').click()
    await page.getByTestId('diff-sub-changes').click()
    await expect(page.getByTestId('diff-file-row').first()).toContainText('index.js')
    await expect(page.locator('.diff-line.add').first()).toContainText('hello world!')

    await page.getByTestId('diff-add-comment-btn').first().click()
    await page.getByTestId('diff-comment-input').fill('Please add a test for this.')
    await page.getByTestId('diff-comment-submit').click()

    await page.getByTestId('diff-sub-commits').click()
    await expect(page.getByTestId('commit-row').first()).toContainText('Change greeting')
    await expect(page.getByTestId('commit-row').nth(1)).toContainText('Initial commit')

    await page.screenshot({ path: join(artifactsDir, '07-diff.png') })

    // The comment must have actually landed in the composer text.
    await page.getByTestId('tab-chat').click()
    await expect(page.getByTestId('composer-input')).toHaveValue(/Please add a test for this\./)
    log('diff panel: inline comment pushed into composer OK')
  })

  // ── 3. Files panel: real tree, syntax highlighting, image + html preview
  test('files panel: real file tree from disk, text highlighting, image preview', async () => {
    await page.getByTestId('tab-files').click()
    await expect(page.getByTestId('files-tree')).toContainText('src')
    await expect(page.getByTestId('files-tree')).toContainText('logo.png')
    await expect(page.getByTestId('files-tree')).toContainText('page.html')

    await page.locator('[data-testid="file-tree-file"][data-path="src/index.js"]').click()
    // Monaco editor is visible and renders the file's text content in .view-line elements
    await expect(page.getByTestId('monaco-editor')).toBeVisible()
    await expect(page.locator('.view-line', { hasText: 'hello world!' }).first()).toBeVisible({ timeout: 10_000 })

    await page.locator('[data-testid="file-tree-file"][data-path="logo.png"]').click()
    await expect(page.getByTestId('file-preview-image')).toBeVisible()
    const src = await page.getByTestId('file-preview-image').getAttribute('src')
    expect(src).toMatch(/^data:image\/png;base64,/)

    await page.locator('[data-testid="file-tree-file"][data-path="page.html"]').click()
    await expect(page.getByTestId('file-preview-html')).toBeVisible()

    // The iframe uses `sandbox=""` (no allow-same-origin), so its document
    // has an opaque origin and is genuinely cross-origin from the page's
    // perspective. Playwright's frameLocator drives it via CDP regardless.
    const previewFrame = page.frameLocator('[data-testid="file-preview-html"]')
    await expect(previewFrame.locator('h1')).toHaveText('Fixture page')

    await page.screenshot({ path: join(artifactsDir, '07-files.png') })
    log('files panel: real tree + text/image/html preview OK')
  })

  // ── 4. Worktree create/list/remove round trip against real disk state ──
  test('worktree panel: create, list, merge, and remove a real git worktree', async () => {
    await page.getByTestId('tab-diff').click()
    await page.getByTestId('diff-sub-worktrees').click()

    await page.getByTestId('worktree-branch-input').fill('feature-x')
    await page.getByTestId('worktree-add').click()
    await expect(page.getByTestId('worktree-row')).toContainText('feature-x', { timeout: 10_000 })

    const worktreeListOutput = git(repoDir, ['worktree', 'list'])
    expect(worktreeListOutput).toContain('feature-x')
    log(`git worktree list after add:\n${worktreeListOutput}`)

    await page.screenshot({ path: join(artifactsDir, '07-worktree.png') })

    await page.getByTestId('worktree-merge').click()
    // Merging a branch identical to HEAD is a real (trivial) fast-forward/no-op merge — still a real `git merge` call.
    await page.waitForTimeout(500)

    await page.getByTestId('worktree-remove').click()
    await expect(page.getByTestId('worktree-row')).toHaveCount(0, { timeout: 10_000 })

    const worktreeListAfterRemove = git(repoDir, ['worktree', 'list'])
    expect(worktreeListAfterRemove).not.toContain('feature-x')
    log(`git worktree list after remove:\n${worktreeListAfterRemove}`)
  })

  // ── 5a. Terminal-only session mode: a real plain shell, no agent ───────
  test('terminal-only session: real shell echoes real output', async () => {
    await stubProjectFolder(electronApp, repoDir)
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    const term = page.getByTestId('terminal-body')
    await term.click()
    await page.waitForTimeout(500) // let the shell finish its startup `cd && clear`
    await page.keyboard.type('echo hello-from-terminal-mode')
    await page.keyboard.press('Enter')

    await expect.poll(async () => term.textContent(), { timeout: 10_000 }).toContain('hello-from-terminal-mode')
    await page.screenshot({ path: join(artifactsDir, '07-terminal.png') })
    log('terminal-only mode: real pty echoed real output OK')
  })

  // ── 5b. Companion terminal drawer: independent shell, open/close ───────
  test('companion terminal drawer: independent shell, open/close, does not affect agent session', async () => {
    // Back to the claude-code session from setup.
    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await row.click()
    await expect(page.getByTestId('tab-strip')).toBeVisible()

    await page.getByTestId('toggle-companion-drawer').click()
    await expect(page.getByTestId('companion-drawer')).toBeVisible()

    const drawerTerm = page.getByTestId('companion-drawer').getByTestId('terminal-body')
    await drawerTerm.click()
    await page.waitForTimeout(500)
    await page.keyboard.type('echo companion-shell-hello')
    await page.keyboard.press('Enter')
    await expect.poll(async () => drawerTerm.textContent(), { timeout: 10_000 }).toContain('companion-shell-hello')

    // Independence: the agent's own transcript is untouched by companion shell activity.
    const transcriptText = await page.getByTestId('transcript').textContent()
    expect(transcriptText).not.toContain('companion-shell-hello')

    await page.screenshot({ path: join(artifactsDir, '07-companion-drawer.png') })

    await page.getByTestId('companion-drawer-close').click()
    await expect(page.getByTestId('companion-drawer')).toHaveCount(0)
    log('companion terminal drawer: independent real shell, open/close OK')
  })

  // ── 6. Ports panel (real devpod) ────────────────────────────────────────
  test('ports panel: real SSH local port forward against qingqin-go.devpod-us-or actually works', async ({}, testInfo) => {
    await stubProjectFolder(electronApp, '') // remote sessions use a text path field, not the picker
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('remote-project-path').fill('/home/user')
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect(page.getByTestId('tab-ports')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('tab-ports').click()

    const localPort = 38022 + (testInfo.repeatEachIndex ?? 0)
    // Forward a local port to the remote's own sshd (22) — a real, always-on
    // listener on qingqin-go.devpod-us-or — so a successful forward can be
    // proven end-to-end by reading a real SSH banner back over it.
    await page.getByTestId('port-local-input').fill(String(localPort))
    await page.getByTestId('port-remote-host-input').fill('127.0.0.1')
    await page.getByTestId('port-remote-port-input').fill('22')
    await page.getByTestId('port-add').click()

    await expect
      .poll(async () => page.getByTestId('port-status').first().textContent(), { timeout: 20_000 })
      .toBe('active')

    await page.screenshot({ path: join(artifactsDir, '07-ports.png') })

    const banner = await connectTcp(localPort, 8000)
    expect(banner.toString('utf-8')).toContain('SSH-')
    log(`port forward localhost:${localPort} -> devpod:22 real SSH banner: ${banner.toString('utf-8').trim()}`)

    await page.getByTestId('port-remove').click()
    await expect(page.getByTestId('port-row')).toHaveCount(0, { timeout: 10_000 })
  })

  // ── 6b. Diff panel (real devpod): git ops must run remotely over SSH ───
  // Bug repro: the Diff tab always shells out to the LOCAL git binary with
  // cwd=projectPath, so for a remote session (where projectPath only exists
  // on the devpod) it always reports "not a git repository" — even though
  // the real remote path is a real repo with real commits (confirmed via
  // `ssh qingqin-go.devpod-us-or -- git -C ~/go-code rev-parse
  // --is-inside-work-tree` -> `true`).
  test('diff panel: real devpod session shows real remote git state, not "not a git repository"', async () => {
    await stubProjectFolder(electronApp, '')
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('remote-project-path').fill('/home/user/go-code')
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect(page.getByTestId('tab-diff')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('tab-diff').click()

    // Wait for the panel to settle out of "Loading diff…" (9 sequential SSH
    // round-trips: isRepo/branch/hasHead/diff for getDiffSummary, plus
    // isRepo/hasHead/log for listCommits, plus isRepo/worktree-list for
    // listWorktrees) before asserting on which state it landed in.
    await expect(page.getByTestId('diff-empty-not-repo').or(page.getByTestId('diff-panel'))).toBeVisible({ timeout: 30_000 })

    // The bug: this must NOT show the "not a git repository" empty state for
    // a real remote repo.
    await expect(page.getByTestId('diff-empty-not-repo')).toHaveCount(0)
    await expect(page.getByTestId('diff-panel')).toBeVisible()

    // Prove it's genuinely talking to the remote repo (not just "isRepo:
    // true" by accident) via a real `git log` round trip over SSH.
    await page.getByTestId('diff-sub-commits').click()
    await expect(page.getByTestId('commit-row').first()).toBeVisible({ timeout: 15_000 })

    await page.screenshot({ path: join(artifactsDir, '07-diff-devpod.png') })
    log('diff panel: real devpod git state shown OK')
  })

  // ── 6c. Terminal (real devpod): bug repro — reported "can't type anything" ──
  // Reported bug: opening the Terminal tab/mode against a real devpod
  // (qingqin-go.devpod-us-or) leaves the shell showing its MOTD/login banner
  // with no visible prompt, and keystrokes never produce any echoed output.
  test('bug repro: terminal-only session on real devpod — typing produces no echoed output', async () => {
    await stubProjectFolder(electronApp, '')
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('remote-project-path').fill('/home/user')
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 20_000 })
    const term = page.getByTestId('terminal-body')

    // Give the real SSH login banner/MOTD time to fully stream in, same as
    // the local terminal test gives the local `cd && clear` time to run.
    await expect.poll(async () => term.textContent(), { timeout: 20_000 }).toContain('Last login')
    await page.screenshot({ path: join(artifactsDir, 'bug-devpod-terminal-01-after-motd.png') })

    await term.click()
    const marker = `gardenia-devpod-terminal-echo-${Date.now()}`
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')

    await page.screenshot({ path: join(artifactsDir, 'bug-devpod-terminal-02-after-typing.png') })
    log(`devpod terminal: after typing "echo ${marker}", terminal-body contains marker echo: ${(await term.textContent())?.includes(marker)}`)

    // This is the bug repro: on `main`, the marker never appears because
    // keystrokes typed after the banner don't reach/echo from the remote shell.
    await expect.poll(async () => term.textContent(), { timeout: 10_000 }).toContain(marker)
  })

  // ── 6d. Terminal tab (real devpod, claude-code session): switching to the
  // tab via its tab button (not clicking inside the terminal body) leaves
  // keyboard focus wherever it was (e.g. the chat composer), so typing after
  // just clicking "Terminal" never reaches the shell — matching the reported
  // "can't type anything" symptom more closely than a fresh terminal-only
  // session (where there's no competing focused element to begin with).
  test('bug repro: Terminal tab on real devpod session — typing after only clicking the tab (no click inside body) is lost', async () => {
    await stubProjectFolder(electronApp, '')
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('remote-project-path').fill('/home/user')
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 20_000 })

    // A prior test in this serial run may have left a different tab active;
    // start from Chat like a real new session would.
    await page.getByTestId('tab-chat').click()

    // Simulate the natural flow: the composer/chat area has focus (as it
    // would after creating/using the session), then the user clicks the
    // Terminal tab button itself — not inside the terminal surface.
    await page.getByTestId('composer-input').click()
    await page.getByTestId('tab-terminal').click()

    const term = page.getByTestId('terminal-body')
    await expect(term).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => term.textContent(), { timeout: 20_000 }).toContain('Last login')
    await page.screenshot({ path: join(artifactsDir, 'bug-devpod-terminal-tab-01-after-motd.png') })

    const marker = `gardenia-devpod-tab-terminal-echo-${Date.now()}`
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await page.screenshot({ path: join(artifactsDir, 'bug-devpod-terminal-tab-02-after-typing.png') })

    const bodyText = await term.textContent()
    log(`Terminal tab (no explicit body click): terminal-body contains marker echo: ${bodyText?.includes(marker)}`)
    log(`Terminal tab (no explicit body click): composer now contains typed text: ${await page.getByTestId('composer-input').inputValue()}`)

    await expect.poll(async () => term.textContent(), { timeout: 10_000 }).toContain(marker)
  })

  // ── 6e. Real bug: React.StrictMode's mount->cleanup->mount (dev-mode only —
  // see src/renderer/src/main.tsx) fires TerminalPanel's pty-lifecycle effect
  // as spawn(P1) -> kill(P1) -> spawn(P2) for the *same* ptyId, all
  // back-to-back with no await between. `pty.ts`'s `proc.onData(...)` never
  // checks whether its own `proc` is still the live entry in `this.ptys`
  // before forwarding to the renderer, so P1's in-flight output keeps
  // leaking through under the same id even after P2 has taken over — this
  // is what corrupted a real user's terminal into duplicated/garbled
  // "cd ... && clear" lines and made it look like typing did nothing.
  // Reproduced here via the real `window.gardenia` IPC bridge (same bridge
  // TerminalPanel itself uses) so it doesn't depend on flaky React dev-mode
  // timing to trigger.
  test('bug repro: rapid respawn under the same ptyId leaks the killed process\'s output forever', async () => {
    const raceId = `strictmode-race-${Date.now()}`

    await page.evaluate(
      ({ id, cwd }) => {
        ;(window as unknown as { __raceLog: string[] }).__raceLog = []
        ;(window as unknown as { __raceUnsub: () => void }).__raceUnsub = window.gardenia.onPtyData(({ id: evId, data }) => {
          if (evId === id) (window as unknown as { __raceLog: string[] }).__raceLog.push(data)
        })
        void window.gardenia.ptySpawn({ id, cwd, hostname: null, cols: 100, rows: 30 })
      },
      { id: raceId, cwd: repoDir }
    )

    await page.waitForTimeout(500) // let P1's real shell actually start
    // P1 (the soon-to-be-killed process) is made to continuously produce
    // output, guaranteeing it's mid-write at the exact moment it's killed —
    // the real-world race is timing-dependent; this makes it deterministic.
    await page.evaluate((id) => void window.gardenia.ptyWrite(id, 'yes P1-LEAK-MARKER\r'), raceId)
    await page.waitForTimeout(500)

    // Simulate StrictMode's synchronous cleanup+remount: kill P1, then
    // immediately spawn P2 for the identical id, no await in between.
    await page.evaluate(
      (id) => {
        void window.gardenia.ptyKill(id)
        void window.gardenia.ptySpawn({ id, cwd: '/tmp', hostname: null, cols: 100, rows: 30 })
      },
      raceId
    )

    // A finite tail of *already-sent* pre-kill messages can still be sitting
    // in Electron's IPC delivery queue at this point (P1 was flooding the
    // channel) — that's expected and not the bug, and not something the
    // renderer can reliably distinguish from a genuine leak by content/count
    // alone. The authoritative check is at the source: `pty.ts` logs every
    // time it detects and drops output from a process that's no longer the
    // current entry for its id (see `logger.info('pty stale-data dropped', ...)`
    // in src/main/panels/pty.ts) — grep the real app log for that, the same
    // pattern this project already uses for bug evidence (see CLAUDE.md §2).
    await page.waitForTimeout(1500)

    const logPath = join(userDataDir, 'logs', 'main.log')
    const droppedForRace = readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg: string; id: string; gen: number; currentGen: number | null })
      .filter((entry) => entry.msg === 'pty stale-data dropped' && entry.id === raceId)

    log(`rapid respawn race: pty.ts dropped ${droppedForRace.length} stale-data event(s) for this race: ${JSON.stringify(droppedForRace)}`)

    await page.evaluate(() => (window as unknown as { __raceUnsub: () => void }).__raceUnsub())
    await page.evaluate((id) => void window.gardenia.ptyKill(id), raceId)

    // Confirms the race was actually hit (P1 really was still mid-write when
    // replaced) *and* that it was correctly intercepted before ever reaching
    // the renderer — the real, source-level fix for the bug, not just an
    // absence-of-symptom check that could pass by luck.
    expect(droppedForRace.length, 'the source-level guard must detect and drop stale data from the killed process').toBeGreaterThan(0)
    for (const entry of droppedForRace) {
      expect(entry.currentGen, 'dropped data must be from an older generation than the current live process').not.toBe(entry.gen)
    }
  })

  // ── 6f. tmux persistence: shell cwd survives TerminalPanel unmount/remount ──
  // When switching sessions, `selectSession()` resets visitedTabs to {chat},
  // which unmounts the outgoing session's TerminalPanel. Its cleanup calls
  // `ptyKill` → `tmux detach-client` then `proc.kill()` — this leaves the
  // named tmux server session alive. When the user switches back, a fresh
  // TerminalPanel mounts, ptySpawn is called, `tmux has-session` finds the
  // existing session, and `tmux attach-session` reattaches — the shell's cwd
  // and any running processes are fully preserved.
  //
  // This test is self-contained: it creates its own two terminal-only sessions
  // (no agent call needed) and uses `data-active="true"` on the session row to
  // find session A's id reliably even when many other sessions already exist.
  test('tmux persistence: shell cwd (/tmp) survives TerminalPanel unmount+remount via session switch', async () => {
    // Guard: skip if tmux is not installed — pty.ts falls back to a plain
    // shell with no persistence guarantee, making this test vacuous.
    let hasTmux = false
    try {
      execFileSync('which', ['tmux'], { encoding: 'utf8' })
      hasTmux = true
    } catch { /* not on PATH */ }
    if (!hasTmux) {
      test.skip(true, 'tmux not installed — terminal persistence test skipped')
      return
    }

    // 1. Create terminal-only session A — no agent SDK call required, just a
    //    real pty. After creation the new session is immediately active.
    await stubProjectFolder(electronApp, repoDir)
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })

    // Capture session A's id via the `data-active="true"` attribute set by
    // Sidebar.tsx on the currently-selected row — reliable regardless of how
    // many other sessions exist in the sidebar.
    const sessionAId = await page
      .locator('[data-testid="session-row"][data-active="true"]')
      .getAttribute('data-session-id')
    expect(sessionAId, 'session A must be the active row after creation').toBeTruthy()
    const rowA = page.locator(`[data-testid="session-row"][data-session-id="${sessionAId}"]`)

    // 2. Wait for the shell prompt, then cd to /tmp. For terminal-only sessions
    //    TerminalPanel is mounted immediately with ptyId=session.id, and pty.ts
    //    runs `tmux new-session -d -s <name> -c <cwd>` then
    //    `tmux attach-session -t <name>` — the pty IS a tmux attach client.
    const termA = page.getByTestId('terminal-body')
    await expect(termA).toBeVisible({ timeout: 10_000 })
    await termA.click()
    await page.waitForTimeout(1000) // tmux attach + shell fully ready

    await page.keyboard.type('cd /tmp')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    // 3. Confirm the cwd is /tmp before switching away.
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect.poll(async () => termA.textContent(), { timeout: 10_000 }).toContain('/tmp')
    await page.screenshot({ path: join(artifactsDir, 'bug-tmux-persistence-01-before-switch.png') })
    log('tmux persistence: /tmp confirmed in session A before switch')

    // 4. Create terminal-only session B to switch to. Navigating to B triggers
    //    selectSession() in App.tsx, which changes activeSession from A to B.
    //    React unmounts session A's TerminalPanel → its cleanup fires:
    //    ptyKill(A.id) → `tmux detach-client -s <name-A>` (graceful detach,
    //    tmux server session stays alive) → proc.kill().
    await stubProjectFolder(electronApp, repoDir)
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(artifactsDir, 'bug-tmux-persistence-02-switched-away.png') })
    log('tmux persistence: switched to session B — session A terminal unmounted, tmux session left alive')

    // 5. Switch back to session A. React mounts a fresh TerminalPanel for A:
    //    ptySpawn(A.id) → `tmux has-session -t <name-A>` succeeds → skip
    //    new-session → `tmux attach-session -t <name-A>` reattaches. The
    //    shell's cwd and running processes are fully restored.
    await rowA.click()
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    const termAfter = page.getByTestId('terminal-body')
    await expect(termAfter).toBeVisible({ timeout: 10_000 })
    await termAfter.click()
    await page.waitForTimeout(1000) // tmux reattach + screen redraw

    // 6. Type pwd again — cwd must still be /tmp. Without tmux (plain shell),
    //    ptySpawn would start a fresh shell in the project folder and /tmp
    //    would never appear here.
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect.poll(async () => termAfter.textContent(), { timeout: 10_000 }).toContain('/tmp')
    await page.screenshot({ path: join(artifactsDir, 'bug-tmux-persistence-03-after-reattach.png') })
    log('tmux persistence: cwd /tmp survived TerminalPanel unmount+remount — OK')
  })

  // ── 6g. devpod tmux persistence: remote shell cwd survives TerminalPanel
  // unmount+remount via session switch, mirroring the local tmux test (6f)
  // but running the tmux session on the devpod over SSH. The flow:
  //   spawn → `ssh <host> tmux new-session -d` (if needed)
  //           `ssh <host> -t tmux attach-session`
  //   kill  → `ssh <host> tmux detach-client` (session survives on remote)
  //   spawn → `ssh <host> tmux has-session` (finds it) → `attach-session`
  // The shell's cwd and running processes are fully preserved across the
  // SSH disconnection because tmux keeps the session alive on the devpod.
  test('devpod tmux persistence: remote shell cwd survives TerminalPanel unmount+remount via session switch', async () => {
    // Resolve which devpod host to use. Prefer the GARDENIA_TEST_DEVPOD env
    // var (matched by sshHost or id), otherwise take the first available host.
    const hosts = await page.evaluate(() => window.gardenia.listHosts())
    const envTarget = process.env.GARDENIA_TEST_DEVPOD
    const devpodHost = envTarget
      ? hosts.find((h) => h.sshHost === envTarget || h.id === envTarget)
      : hosts[0]

    test.skip(!devpodHost, 'No devpod configured — set GARDENIA_TEST_DEVPOD env var or configure a devpod host')
    if (!devpodHost) return

    log(`devpod tmux persistence: using host ${devpodHost.sshHost} (id=${devpodHost.id})`)

    // 1. Create a terminal-only session on the devpod.
    await stubProjectFolder(electronApp, '')
    await page.getByTestId('new-session-button').click()
    await page.getByTestId(`host-option-${devpodHost.id}`).click()
    await page.getByTestId('remote-project-path').fill('/home/user')
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 20_000 })

    // Capture the devpod session's id so we can click back to it after switching away.
    const sessionDevpodId = await page
      .locator('[data-testid="session-row"][data-active="true"]')
      .getAttribute('data-session-id')
    expect(sessionDevpodId, 'devpod session must be the active row after creation').toBeTruthy()
    const rowDevpod = page.locator(`[data-testid="session-row"][data-session-id="${sessionDevpodId}"]`)

    // Shell-readiness probe that distinguishes EXECUTED output from typed command text.
    //
    // The problem: xterm's textContent() contains BOTH the typed command (echoed by
    // the terminal) AND the shell's actual output. Checking `textContent().toContain(X)`
    // where X is part of the typed command fires immediately on typing — before the
    // shell executes anything — giving a false "shell is ready" signal.
    //
    // Solution: `printf 'MARKER:'; pwd`
    //   typed command text:  printf 'MARKER:'; pwd   ← contains `MARKER:'` (single quote)
    //   shell output:        MARKER:/home/user/...   ← contains `MARKER:/` (slash)
    // Searching for `MARKER:/` (with slash) uniquely identifies the OUTPUT; it cannot
    // appear in the typed command text, which has a `'` immediately after `MARKER:`.
    const cwdProbe = async (term: ReturnType<typeof page.getByTestId>, timeout: number) => {
      const marker = `gdprb${Date.now()}`
      await term.click()
      await page.keyboard.type(`printf '${marker}:'; pwd`)
      await page.keyboard.press('Enter')
      // `marker:/` only appears in the shell output, never in the typed command text
      await expect.poll(async () => term.textContent(), { timeout }).toContain(`${marker}:/`)
      const content = await term.textContent() ?? ''
      const idx = content.indexOf(`${marker}:/`)
      // Slice from the `/` in the marker output to read the actual path
      return content.slice(idx + marker.length + 1, idx + marker.length + 80)
    }

    // 2. Wait for the shell to be live, then verify it by actually executing a
    //    command and reading its output (not just observing typed text).
    const termDevpod = page.getByTestId('terminal-body')
    await expect(termDevpod).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(5000) // SSH + tmux new-session + attach typically 3-5s

    const pathBefore = await cwdProbe(termDevpod, 25_000)
    log(`devpod tmux persistence: initial cwd: ${pathBefore.slice(0, 50)}`)

    // 3. cd into ~/go-code and confirm the cwd changed.
    await page.keyboard.type('cd ~/go-code')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    const pathAfterCd = await cwdProbe(termDevpod, 10_000)
    expect(pathAfterCd, 'cwd must be in go-code before switching away').toContain('go-code')
    await page.screenshot({ path: join(artifactsDir, 'devpod-tmux-persistence-01-before-switch.png') })
    log(`devpod tmux persistence: go-code cwd confirmed before switch (path: ${pathAfterCd.slice(0, 50)})`)

    // 4. Create a local terminal-only session to switch to. This triggers
    //    selectSession() in App.tsx → React unmounts the devpod TerminalPanel
    //    → its cleanup fires ptyKill → proc.kill() drops the SSH connection;
    //    the remote tmux server detects the disconnect and detaches the client,
    //    leaving the named tmux session (and its shell's cwd) alive on the devpod.
    await stubProjectFolder(electronApp, repoDir)
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(artifactsDir, 'devpod-tmux-persistence-02-switched-away.png') })
    log('devpod tmux persistence: switched to local session B — devpod terminal unmounted, remote tmux session left alive')

    // 5. Switch back to the devpod session. React mounts a fresh TerminalPanel:
    //    ptySpawn → `ssh <host> tmux has-session` succeeds → skip new-session →
    //    `ssh <host> -t tmux attach-session` reattaches to the live remote session.
    await rowDevpod.click()
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    const termAfter = page.getByTestId('terminal-body')
    await expect(termAfter).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(6000) // SSH reconnect + tmux has-session + attach

    // 6. Verify the cwd is STILL go-code after reattach. Without remote tmux,
    //    the SSH session ends on disconnect and a fresh shell starts in the
    //    default home dir — the probe would return `/home/user` (no go-code).
    const pathAfterReattach = await cwdProbe(termAfter, 25_000)
    expect(pathAfterReattach, 'cwd must still be in go-code after SSH disconnect+reattach').toContain('go-code')
    await page.screenshot({ path: join(artifactsDir, 'devpod-tmux-persistence-03-after-reattach.png') })
    log(`devpod tmux persistence: cwd go-code survived SSH disconnect+reattach via remote tmux — OK (path: ${pathAfterReattach.slice(0, 50)})`)
  })

  // ── 7. External links open the OS browser, never an embedded view ─────
  test('external links: clicking a real rendered link invokes shell.openExternal with the right URL, never navigates in-app', async () => {
    await electronApp.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        // @ts-expect-error test-only bookkeeping read back below
        globalThis.__lastOpenedExternalUrl = url
        return undefined
      }
    })

    // Back to the real local session (the remote session from the Ports
    // test has no local git repo to diff against locally).
    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await row.click()
    await page.getByTestId('tab-diff').click()
    await page.getByTestId('diff-sub-commits').click()

    // The commit log renders the real commit message through the same
    // Linkify component used everywhere else — click the real, naturally
    // rendered link (not a synthetic DOM node) to prove the actual
    // production code path end-to-end.
    const realLink = page.getByTestId('external-link').first()
    await expect(realLink).toContainText('https://example.com/gardenia-e2e-external-link-check')
    await realLink.click()

    const openedUrl = await electronApp.evaluate(() => {
      // @ts-expect-error test-only bookkeeping
      return globalThis.__lastOpenedExternalUrl ?? null
    })
    expect(openedUrl).toBe('https://example.com/gardenia-e2e-external-link-check')
    expect(page.url()).not.toContain('example.com')
    log(`shell.openExternal invoked with real Linkify-rendered link: ${openedUrl}`)
  })

  // ── 6h. SSH ControlMaster: devpod terminal must create a mux socket ────────
  // Fix: SSH slowness (13s per open, 3 cold crypto handshakes) was resolved by
  // adding ControlMaster=auto + ControlPath=/tmp/gardenia-ssh-%C to all SSH
  // execFileSync calls in pty.ts. After the first connection, subsequent SSH
  // calls reuse the socket (<5ms each). This test verifies the socket is
  // actually created, proving the ControlMaster path is exercised.
  test('SSH ControlMaster: devpod terminal open creates a multiplexing socket in /tmp', async () => {
    const hosts = await page.evaluate(() => window.gardenia.listHosts())
    const envTarget = process.env.GARDENIA_TEST_DEVPOD
    const devpodHost = envTarget
      ? hosts.find((h) => h.sshHost === envTarget || h.id === envTarget)
      : hosts[0]

    test.skip(!devpodHost, 'No devpod configured — set GARDENIA_TEST_DEVPOD or configure a devpod host')
    if (!devpodHost) return

    log(`SSH ControlMaster: using host ${devpodHost.sshHost} (id=${devpodHost.id})`)

    // Remove any pre-existing gardenia-ssh-* sockets so we can confirm a new
    // one is created by this connection (not a leftover from a prior test).
    const socketsBefore = readdirSync('/tmp').filter((f) => f.startsWith('gardenia-ssh-'))
    socketsBefore.forEach((f) => {
      try { require('node:fs').unlinkSync(`/tmp/${f}`) } catch { /* best-effort */ }
    })

    await stubProjectFolder(electronApp, '')
    await page.getByTestId('new-session-button').click()
    await page.getByTestId(`host-option-${devpodHost.id}`).click()
    await page.getByTestId('remote-project-path').fill('/tmp')
    await page.getByTestId('mode-terminal').click()
    const t0 = Date.now()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 30_000 })

    // Track this session's id so we can click back to it after switching away.
    const devpodSessionId = await page
      .locator('[data-testid="session-row"][data-active="true"]')
      .getAttribute('data-session-id')
    const devpodRow = page.locator(`[data-testid="session-row"][data-session-id="${devpodSessionId}"]`)

    // Wait for the shell to be responsive.
    const term = page.getByTestId('terminal-body')
    await expect(term).toBeVisible({ timeout: 10_000 })
    await term.click()
    await page.waitForTimeout(3_000) // SSH + tmux attach

    const marker = `ctrl-${Date.now()}`
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect.poll(async () => term.textContent(), { timeout: 20_000 }).toContain(marker)
    log(`SSH ControlMaster: shell responsive in ${Date.now() - t0}ms`)

    // The ControlMaster socket must now exist in /tmp.
    // ControlPath=/tmp/gardenia-ssh-%C — %C is OpenSSH's SHA1 hash of the
    // connection parameters, so the file name is a hex string.
    const socketsAfter = readdirSync('/tmp').filter((f) => f.startsWith('gardenia-ssh-'))
    log(`SSH ControlMaster: sockets in /tmp after connect: ${socketsAfter.join(', ')}`)
    expect(
      socketsAfter.length,
      'ControlMaster socket must be present in /tmp — SSH_MUX_OPTS not applied if missing'
    ).toBeGreaterThan(0)

    // Switch to another session, then come back — the terminal must reconnect
    // immediately via the ControlMaster socket. Without it, the reconnect
    // requires 3 fresh SSH handshakes (~4.5s each = 13s total), which would
    // blow the 6s poll timeout below.
    await page.locator(`[data-testid="session-row"]:not([data-session-id="${devpodSessionId}"])`).first().click()
    await page.waitForTimeout(800) // let ptyKill + tmux detach-client fire

    const tReconnect = Date.now()
    await devpodRow.click()
    await expect(page.getByTestId('terminal-body')).toBeVisible({ timeout: 10_000 })
    // The tmux session on the devpod is still alive — its scrollback buffer
    // (including the marker echo from before) must appear immediately after
    // reattach. A 6s timeout fits ControlMaster reconnect (<1s) but not a
    // cold-handshake reconnect (~13s).
    await expect.poll(
      async () => page.getByTestId('terminal-body').textContent(),
      { timeout: 6_000 }
    ).toContain(marker)
    log(`SSH ControlMaster: reconnect showed tmux content in ${Date.now() - tReconnect}ms`)

    await page.screenshot({ path: join(artifactsDir, '07-ssh-controlmaster.png') })
  })
})

