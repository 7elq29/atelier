#!/usr/bin/env node
/**
 * Postinstall patches for node-pty on macOS/Electron:
 * - spawn-helper +x (microsoft/node-pty#850)
 * - helperPath: don't double-rewrite app.asar.unpacked (node-pty#923)
 */
const { chmodSync, existsSync, readFileSync, writeFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

const ptyRoot = join(__dirname, '..', 'node_modules', 'node-pty')
if (!existsSync(ptyRoot)) process.exit(0)

function chmodSpawnHelpers() {
  const { execSync } = require('node:child_process')
  try {
    execSync(`find "${ptyRoot}" -name spawn-helper -print0 | xargs -0 chmod +x`, { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

function patchUnixTerminalHelperPath() {
  const file = join(ptyRoot, 'lib', 'unixTerminal.js')
  if (!existsSync(file)) return
  const src = readFileSync(file, 'utf8')
  const needle = `helperPath = path.resolve(__dirname, helperPath);
helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');`
  const replacement = `helperPath = path.resolve(__dirname, helperPath);
if (!helperPath.includes('app.asar.unpacked')) {
  helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
  helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');
} else {
  helperPath = helperPath.replace(/app\\.asar\\.unpacked\\.unpacked/g, 'app.asar.unpacked');
}`
  if (src.includes('app.asar.unpacked.unpacked')) return
  if (!src.includes(needle)) {
    console.warn('patch-node-pty: unixTerminal.js helperPath block not found — skip')
    return
  }
  writeFileSync(file, src.replace(needle, replacement))
  console.log('patch-node-pty: patched unixTerminal.js helperPath (node-pty#923)')
}

chmodSpawnHelpers()
patchUnixTerminalHelperPath()
