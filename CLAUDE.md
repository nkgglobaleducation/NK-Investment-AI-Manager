# NK Academy — Data Portal

Two-portfolio Indian equity tracker. **Google Apps Script web app** (NOT a normal
Node/web project). Files: `Code.js` (server backend) + `Index.html` (single-page UI),
both bound to one Google Sheet.

## How this is deployed (important)
- This is Apps Script. There is no build step, no npm run, no local server.
- Local files are synced to the live web app with **clasp**: `clasp push` sends
  `Code.js` + `Index.html` to Apps Script. `clasp pull` brings the live version down.
- GitHub is backup/version control only. Pushing to GitHub does NOT update the live
  portal — that requires `clasp push`.
- Full cycle after an edit: edit locally → `git push` (backup) → `clasp push` (go live).
- Before editing on any machine: `git pull` first (code lives across 3 machines).

## Hard rules — do not change these without being asked
- **EXIT NOW is purely AI-generated. NEVER add a Net%-loss threshold or any mechanical
  rule that sets EXIT NOW.** Net% is passed to the AI as context only; the model decides.
  A hybrid rule was considered and explicitly rejected.
- **Dashboard table must never have horizontal scroll.** Keep every column at the minimum
  width its content needs; let the AI Rationale column absorb the freed space.
- Keep the preview-mode guard in `Index.html` (buttons render inert outside Apps Script).
- API keys live in Script Properties, never returned to the client. Don't expose them.

## Known quirks (these are intentional, not bugs — don't "fix" without asking)
- GOOGLEFINANCE attribute names are `high52` / `low52` (NOT `52weekhigh`). Using the wrong
  name silently returns 0 via the IFERROR fallback.
- All-time-high has no native GOOGLEFINANCE field. It's derived by a WEEKLY historical
  scan back to 2000 (`ATH_START_DATE`). This is the heaviest calculation and is why
  `refreshLivePrices()` waits `LIVE_PRICES_WAIT_MS` (~15s) before freezing values.
- `%LOW 52WH` and `%LOW ATH` render green for larger drawdowns (bigger discount = bigger
  number). This is deliberate, even though green normally means "up" elsewhere.
- `fmtPct` currently shows `0.0%` when there's no price data — indistinguishable from a
  stock genuinely at its high/low. A dash fallback is a known desired improvement.
- PE returns 0 for loss-making companies (no meaningful P/E); shown as `—`, not an error.

## Architecture quick map
- `doGet()` serves `Index.html`.
- Sheet tabs: P1_Holdings, P2_Holdings, Screener, LivePrices, AI_Analysis, Indices.
- `uploadCSV()` parses P1/P2 holdings or screener CSV into the sheet.
- `refreshLivePrices()` writes GOOGLEFINANCE formulas (LTP, day%, 52w H/L, ATH, mkt cap,
  PE) + the 3 indices, waits, then freezes values.
- AI: `startAIAnalysis()` → installs a 1-minute time-driven trigger →
  `processAIBatch()` runs batches of 10 server-side (survives browser close);
  client polls `getAIProgress()`. Providers rotate through 8 slots in `AI_SLOTS`
  (Groq/Gemini/Cerebras/OpenRouter/Mistral) with per-slot cooldowns for rate/quota limits.
- Watchlist stars: `toggleStar()`, stored in User Properties.

## Working style
- Show me the diff and wait for approval before editing (I keep "Accept edits" off).
- Prefer minimal, targeted changes. Don't refactor unrelated code.
- If a change touches the sheet schema or GOOGLEFINANCE formulas, call it out explicitly.
