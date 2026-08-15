import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'

const repoRoot = resolve(__dirname)
let nodeModulesRoot = resolve(repoRoot, 'node_modules')
try {
  nodeModulesRoot = realpathSync(nodeModulesRoot)
} catch {
  // node_modules may be absent in CI until install
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    server: {
      fs: {
        // Worktrees often symlink node_modules to the main repo — allow the real path.
        allow: [repoRoot, nodeModulesRoot]
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react(), (monacoEditorPlugin as unknown as { default: typeof monacoEditorPlugin }).default({ customWorkers: [] })]
  }
})
