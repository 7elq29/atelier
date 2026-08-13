import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    env: {
      ATELIER_DISABLE_UBER_AUTH_BOOTSTRAP: '1',
    },
  },
  projects: [
    {
      name: 'electron'
    }
  ]
})
