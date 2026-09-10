#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mapPath = resolve(repoRoot, 'e2e/test-impact-map.json')
const impactMap = JSON.parse(readFileSync(mapPath, 'utf8'))

function globRegex(pattern) {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i++
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

const compiled = {
  ignore: impactMap.ignore.map(globRegex),
  rules: impactMap.rules.map((rule) => ({
    ...rule,
    pathMatchers: rule.paths.map(globRegex),
    lineMatcher: rule.changedLines ? new RegExp(rule.changedLines, 'i') : null
  })),
  fallbacks: impactMap.fallbacks.map((rule) => ({
    ...rule,
    pathMatchers: rule.paths.map(globRegex)
  }))
}

function matchesPath(rule, path) {
  return rule.pathMatchers.some((matcher) => matcher.test(path))
}

function addTarget(selected, target, reason) {
  const current = selected.get(target.file) ?? { wholeFile: false, greps: new Set(), reasons: new Set() }
  if (target.grep) current.greps.add(target.grep)
  else current.wholeFile = true
  current.reasons.add(reason)
  selected.set(target.file, current)
}

export function selectAffected(changes) {
  const selected = new Map()
  const unmapped = []

  for (const change of changes) {
    const path = change.path.replaceAll('\\', '/')
    if (/^e2e\/.*\.spec\.ts$/.test(path)) {
      addTarget(selected, { file: path }, `${path} changed`)
      continue
    }
    if (compiled.ignore.some((matcher) => matcher.test(path))) continue
    if (
      path === 'e2e/test-impact-map.json' ||
      path === 'scripts/e2e-affected.mjs' ||
      path === 'CLAUDE.md'
    ) {
      continue
    }

    const hunks = change.hunks?.length ? change.hunks : [change.changedLines]
    const candidateLineRules = compiled.rules.filter(
      (rule) => rule.lineMatcher && matchesPath(rule, path)
    )
    const matchedLineRules = new Set(
      candidateLineRules.filter((rule) => hunks.some((hunk) => rule.lineMatcher.test(hunk)))
    )
    const hasUnownedHunk = hunks.some(
      (hunk) => !candidateLineRules.some((rule) => rule.lineMatcher.test(hunk))
    )
    const rules = [...matchedLineRules]
    if (matchedLineRules.size === 0 || hasUnownedHunk) {
      const directRules = compiled.rules.filter((rule) => !rule.lineMatcher && matchesPath(rule, path))
      const broadRules =
        directRules.length > 0
          ? directRules
          : compiled.fallbacks.filter((rule) => matchesPath(rule, path))
      rules.push(...broadRules)
    }

    if (rules.length === 0) {
      if (path.startsWith('src/')) unmapped.push(path)
      continue
    }
    for (const rule of rules) {
      for (const target of rule.targets) addTarget(selected, target, `${path} → ${rule.id}`)
    }
  }

  const targets = [...selected.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, value]) => ({
      file,
      grep: value.wholeFile ? null : [...value.greps].sort().map((grep) => `(?:${grep})`).join('|'),
      reasons: [...value.reasons].sort()
    }))
  return { targets, unmapped: [...new Set(unmapped)].sort() }
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function safeGit(args) {
  try {
    return git(args)
  } catch {
    return ''
  }
}

function diffNames(range) {
  if (!range) return []
  const output = safeGit(['diff', '--name-only', '--no-renames', range])
  return output ? output.split('\n').filter(Boolean) : []
}

function changedLinesFor(path, ranges, untracked) {
  if (untracked.has(path)) {
    const absolute = resolve(repoRoot, path)
    const content = existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, 'utf8') : ''
    return { changedLines: content, hunks: content ? [content] : [] }
  }
  const patch = ranges
    .map((range) => safeGit(['diff', '--unified=1', '--no-renames', range, '--', path]))
    .join('\n')
  const hunks = patch
    .split(/^@@.*@@.*$/m)
    .slice(1)
    .map((hunk) =>
      hunk
        .split('\n')
        .filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line))
        .map((line) => (/^[ +\-]/.test(line) ? line.slice(1) : line))
        .join('\n')
        .trim()
    )
    .filter(Boolean)
  return { changedLines: hunks.join('\n'), hunks }
}

function parseArgs(argv) {
  const options = {
    base: null,
    head: 'HEAD',
    list: false,
    json: false,
    selfTest: false,
    files: [],
    playwrightArgs: []
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base') options.base = argv[++i]
    else if (arg === '--head') options.head = argv[++i]
    else if (arg === '--files') options.files.push(...argv[++i].split(',').filter(Boolean))
    else if (arg === '--list' || arg === '--dry-run') options.list = true
    else if (arg === '--json') options.json = true
    else if (arg === '--self-test') options.selfTest = true
    else options.playwrightArgs.push(arg)
  }
  return options
}

function collectGitChanges(options) {
  if (options.files.length > 0) {
    return options.files.map((path) => ({ path, changedLines: '' }))
  }

  const base =
    options.base ??
    safeGit(['merge-base', options.head, 'main']) ??
    options.head
  const committedRange = base && base !== options.head ? `${base}...${options.head}` : null
  const workingRange = options.head === 'HEAD' ? 'HEAD' : null
  const ranges = [committedRange, workingRange].filter(Boolean)
  const untrackedOutput = options.head === 'HEAD' ? safeGit(['ls-files', '--others', '--exclude-standard']) : ''
  const untracked = new Set(
    untrackedOutput
      ? untrackedOutput
          .split('\n')
          .filter(Boolean)
          .filter((path) => {
            const absolute = resolve(repoRoot, path)
            return existsSync(absolute) && statSync(absolute).isFile()
          })
      : []
  )
  const paths = new Set([...ranges.flatMap(diffNames), ...untracked])

  return [...paths].sort().map((path) => ({
    path,
    ...changedLinesFor(path, ranges, untracked)
  }))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function runSelfTest() {
  const ids = [...impactMap.rules, ...impactMap.fallbacks].map((rule) => rule.id)
  assert(new Set(ids).size === ids.length, 'Impact-map rule ids must be unique')
  for (const rule of [...impactMap.rules, ...impactMap.fallbacks]) {
    for (const target of rule.targets) {
      assert(
        existsSync(resolve(repoRoot, target.file)),
        `Impact-map target does not exist (${rule.id}): ${target.file}`
      )
    }
  }

  const dailyCss = selectAffected([
    {
      path: 'src/renderer/src/styles/global.css',
      changedLines: '.daily-note-header-controls { display: flex; }',
      hunks: ['.daily-note-header-controls { display: flex; }']
    }
  ])
  assert(dailyCss.unmapped.length === 0, 'Daily CSS should be mapped')
  assert(dailyCss.targets.length === 1, 'Daily CSS should select one target')
  assert(dailyCss.targets[0].file === 'e2e/daily-note-notes-editor.spec.ts', 'Daily CSS selected the wrong spec')
  assert(dailyCss.targets[0].grep?.includes('opens from sidebar'), 'Daily CSS should select the focused header test')

  const pty = selectAffected([{ path: 'src/main/panels/pty.ts', changedLines: 'set-option mouse on' }])
  assert(pty.targets.length === 1 && pty.targets[0].file === 'e2e/terminal-pty.spec.ts', 'pty.ts should select terminal-pty only')

  const dailyFallback = selectAffected([
    { path: 'src/renderer/src/components/panels/DailyNoteEditorPanel.tsx', changedLines: 'editorHandleRef.current' }
  ])
  assert(dailyFallback.targets.length === 1 && dailyFallback.targets[0].grep === null, 'Unrecognized Daily Note changes should run its whole spec')

  const changedSpec = selectAffected([
    { path: 'e2e/model-effort-picker.spec.ts', changedLines: 'test(...)' }
  ])
  assert(changedSpec.targets.length === 1 && changedSpec.targets[0].grep === null, 'A changed spec should select itself')

  const unknown = selectAffected([{ path: 'src/renderer/src/components/NewThing.tsx', changedLines: '' }])
  assert(unknown.targets.length === 0 && unknown.unmapped[0]?.endsWith('NewThing.tsx'), 'Unknown source must fail closed')

  const mixedCss = selectAffected([
    {
      path: 'src/renderer/src/styles/global.css',
      changedLines: '.daily-sync-chip {} .unowned-layout {}',
      hunks: ['.daily-sync-chip { font-size: 10px; }', '.unowned-layout { display: grid; }']
    }
  ])
  assert(
    mixedCss.targets.some((target) => target.file === 'e2e/audit-window-resize-layout.spec.ts'),
    'An unowned shared-CSS hunk must add the broad layout fallback'
  )

  console.log('Affected E2E selector self-test passed (map integrity + 6 selection cases).')
}

function printSelection(changes, result, json) {
  if (json) {
    console.log(JSON.stringify({ changes, ...result }, null, 2))
    return
  }
  console.log(`Changed paths (${changes.length}):`)
  for (const change of changes) console.log(`  ${change.path}`)
  console.log(`\nSelected E2E targets (${result.targets.length}):`)
  for (const target of result.targets) {
    console.log(`  ${target.file}${target.grep ? `  --grep ${JSON.stringify(target.grep)}` : ''}`)
    for (const reason of target.reasons) console.log(`    ${reason}`)
  }
}

function runTargets(targets, passthrough) {
  const playwright = resolve(
    repoRoot,
    'node_modules/.bin',
    process.platform === 'win32' ? 'playwright.cmd' : 'playwright'
  )
  const wholeFiles = targets.filter((target) => !target.grep).map((target) => target.file)
  const commands = []
  if (wholeFiles.length > 0) commands.push([...wholeFiles, ...passthrough])
  for (const target of targets.filter((item) => item.grep)) {
    commands.push([target.file, '--grep', target.grep, ...passthrough])
  }

  for (const args of commands) {
    console.log(`\n> playwright test ${args.map((arg) => JSON.stringify(arg)).join(' ')}`)
    const result = spawnSync(playwright, ['test', ...args], { cwd: repoRoot, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exitCode = result.status ?? 1
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.selfTest) {
  runSelfTest()
} else {
  const changes = collectGitChanges(options)
  const result = selectAffected(changes)
  printSelection(changes, result, options.json)

  if (result.unmapped.length > 0) {
    console.error('\nUnmapped production source files:')
    for (const path of result.unmapped) console.error(`  ${path}`)
    console.error('Add a narrow ownership rule to e2e/test-impact-map.json; refusing to skip tests silently.')
    process.exitCode = 2
  } else if (!options.list && !options.json) {
    if (result.targets.length === 0) console.log('\nNo runtime E2E tests are affected.')
    else runTargets(result.targets, options.playwrightArgs)
  }
}
