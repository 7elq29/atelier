# Renew USSO must open the weblogin page

## Bug
Dock-launched Atelier runs `usso -fetch genai-api -print` with no TTY.
usso prints `https://usso.uberinternal.com/oidauth/weblogin` then dies with
`open /dev/tty: device not configured` — **never opens a browser**. Clicking
**Renew USSO** therefore looked like a no-op (main.log 2026-11-10).

## Expected
1. Click **Renew USSO** → system **browser** opens the USSO weblogin URL.
2. Complete `usso -fetch` on a **hidden internal PTY** (`node-pty`) so it has a
   TTY — never open macOS Terminal.app and never surface Atelier’s terminal UI
   (that confuses users for a simple auth renew).
3. Auto interactive fetch (once per process) that hits the same TTY failure
   also opens the weblogin URL once (matches “at most one browser open”).
4. E2E fixture counts opens without launching a real browser / PTY wait.

## Done
- [x] Renew click increments `webloginOpenCount` / opens URL
- [x] TTY-failure path opens weblogin (auto once)
- [x] Manual renew uses hidden node-pty for `usso -fetch` (no Terminal.app)
- [x] `npm run build`; spend-status chip e2e (USSO expired) passes
