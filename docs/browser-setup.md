# Browser Automation Setup (WSL2)

JobBot uses Playwright for browser automation. Since you're running WSL2, here's how to set it up.

## Quick Start

```bash
# Install Playwright + Chromium in WSL
pnpm add -D @playwright/test
pnpm exec playwright install chromium

# Install WSL system dependencies for Chromium
sudo apt update
sudo apt install -y \
  libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64
```

## Display Modes on WSL2

### Mode 1: Headless (Recommended default)

No display needed. Works everywhere. Good for CI and scripted runs.

```
headless: true  # in playwright.config.ts
```

### Mode 2: WSLg (Headed, for debugging)

WSL2 includes WSLg — built-in GUI support. Playwright-headed browsers
automatically render through WSLg.

```bash
# Test that WSLg works
echo $DISPLAY
# Should show something like :0

# If blank, WSLg may not be enabled. Check:
#   wsl --version  (need WSL 2.x+)
#   wsl --update
```

Then in `playwright.config.ts`:
```
headless: false
```

Or at runtime:
```bash
HEADLESS=false pnpm jobbot apply --job 123 --dry-run
```

### Mode 3: Use Windows Chrome from WSL (Alternative)

You can connect Playwright running in WSL to a Chrome instance on the Windows host:

```powershell
# In Windows PowerShell (run once):
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="C:\jobbot-browser-profile"
```

```bash
# Then in WSL, set this env var:
export JOBOT_BROWSER_WS="ws://$(ip route show default | cut -d' ' -f3):9222"
```

This avoids running a second browser in WSL. But **always use the dedicated
`jobbot-browser-profile` directory** — never your main Chrome profile.

## Why a Dedicated Browser Profile?

```
your main Chrome profile
  ❌ has your personal logins, bookmarks, cookies
  ❌ could leak personal data into job applications
  ❌ could have extensions that interfere

jobbot browser profile (local/browser-data/profile/)
  ✅ isolated cookies and sessions
  ✅ only job board logins
  ✅ clean state for automation
  ✅ nothing shared with your main browsing
```

## Security Notes

- The `local/browser-data/` directory is in `.gitignore` — never commit it.
- This profile stores cookies and sessions locally. Treat it like a password.
- For Playwright MCP in Claude Code, use `--isolated` mode so the MCP server
  doesn't share state with your personal browser.

## Playwright MCP (for Claude Code)

Claude Code can control the browser directly via Playwright MCP. Add to
`.mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@anthropic/mcp-server-playwright", "--isolated"]
    }
  }
}
```

This lets Claude Code browse job boards and fill forms — but always
under the safety rules (dry-run by default, never auto-submit).
