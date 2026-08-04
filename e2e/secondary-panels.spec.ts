import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
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
    await expect(page.getByTestId('file-content')).toContainText('hello world!')
    await expect(page.locator('.tok-key').first()).toBeVisible()

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
})
