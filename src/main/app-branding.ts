import { app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Resolve chevron app icon (#10) for window / App Switcher (80% inset). */
export function resolveAppIconPath(): string | undefined {
  const candidates = [
    join(__dirname, '../renderer/icon.png'),
    join(__dirname, '../../build/icon.png'),
    join(app.getAppPath(), 'build/icon.png'),
    join(app.getAppPath(), 'src/renderer/public/icon.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return undefined
}

/** Dock-only asset — slightly larger art; macOS shrinks transparent dock PNGs extra. */
export function resolveDockIconPath(): string | undefined {
  const candidates = [
    join(__dirname, '../renderer/icon-dock.png'),
    join(__dirname, '../../build/icon-dock.png'),
    join(app.getAppPath(), 'build/icon-dock.png'),
    join(app.getAppPath(), 'src/renderer/public/icon-dock.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return resolveAppIconPath()
}

/** Override Dock icon on macOS (App Switcher keeps window/bundle icon). */
export function applyDockIconWhenReady(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const iconPath = resolveDockIconPath()
  if (!iconPath) return
  const image = nativeImage.createFromPath(iconPath)
  if (!image.isEmpty()) app.dock.setIcon(image)
}
