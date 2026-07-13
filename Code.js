/**************************************************************
 * NK ACADEMY — DATA PORTAL  v2  (Google Apps Script Web App)
 * UPDATED: Added 3 new live columns for 52-week & all-time analysis
 * ------------------------------------------------------------
 * Persistence  : Google Sheets (P1, P2, Screener, Prices, AI)
 * Live prices  : GOOGLEFINANCE (NSE/BOM) — "Live Prices" button
 * AI analysis  : SERVER-SIDE via time-driven trigger (runs even
 *                if the browser is closed). Multi-provider slot
 *                rotation: Groq / Gemini / Cerebras / OpenRouter
 *                / Mistral — each model has its own free-quota
 *                bucket & cooldown. One combined call per batch
 *                returns suggestion + rationale + alternate.
 **************************************************************/

const SHEET_ID = '1i-yJx4H3PUKhaADvxDPJIVV3Z4gmPtjdGbuejQwWpCw';

const TAB_P1       = 'P1_Holdings';
const TAB_P2       = 'P2_Holdings';
const TAB_SCREENER = 'Screener';
const TAB_PRICES   = 'LivePrices';
const TAB_AI       = 'AI_Analysis';
const TAB_INDICES  = 'Indices';

// Ticker syntax confirmed via GOOGLEFINANCE docs/community examples for Indian indices.
const INDEX_LIST = [
  { key:'NIFTY50',   label:'NIFTY 50',   ticker:'INDEXNSE:NIFTY_50' },
  { key:'BANKNIFTY', label:'NIFTY BANK', ticker:'INDEXNSE:NIFTY_BANK' },
  { key:'SENSEX',    label:'SENSEX',     ticker:'INDEXBOM:SENSEX' },
  // Global indices — standard GOOGLEFINANCE index tickers, resolve like any other index.
  { key:'DOWJONES',  label:'DOW JONES',  ticker:'INDEXDJX:.DJI' },
  { key:'NASDAQ',    label:'NASDAQ',     ticker:'INDEXNASDAQ:.IXIC' },
  { key:'SP500',     label:'S&P 500',    ticker:'INDEXSP:.INX' },
  // Commodities — GOOGLEFINANCE has no native commodity/futures feed.
  // GOLD uses the XAU "currency" trick: price of 1 troy oz of gold in USD (NOT ₹/10g MCX gold).
  { key:'GOLD',  label:'GOLD (USD/oz)', ticker:'CURRENCY:XAUUSD' },
  // USD/INR: GOOGLEFINANCE's CURRENCY: tickers don't reliably resolve when written via the
  // Apps Script API (confirmed — always came back 0), so this one is fetched separately from
  // a free public forex API instead of a GOOGLEFINANCE formula. See fetchUsdInrRate_() below.
  { key:'USDINR', label:'USD/INR', ticker:null }
  // GIFT NIFTY intentionally NOT included: NSE IX isn't a supported GOOGLEFINANCE exchange
  // prefix, and no free public API exists for it either — it would just show "—" forever if added.
  // GOLD (CURRENCY:XAUUSD) has the same GOOGLEFINANCE-from-Apps-Script issue as USD/INR did and
  // is left as-is (shows "—") until a metals-price API key is added — see CLAUDE.md if revisiting.
  // BRENT CRUDE removed (was here as a BNO ETF proxy) — its price doesn't track real Brent crude
  // closely enough to show (was ~$42 vs real ~$76). Needs a real commodities API (e.g. Alpha
  // Vantage's free BRENT endpoint) to do properly — left as "—" in the UI until that's added.
];

/* USD/INR via a free, no-key forex API (open.er-api.com) since GOOGLEFINANCE's CURRENCY: ticker
 * doesn't resolve reliably from Apps Script. NOTE: this API only updates once every ~24h, so
 * unlike every other live figure on this dashboard, USD/INR will NOT move intraday — it's a
 * daily rate, not a live tick. Returns 0 on any failure (network, parse, missing field). */
function fetchUsdInrRate_() {
  try {
    const res = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/USD', { muteHttpExceptions: true });
    const json = JSON.parse(res.getContentText());
    return (json && json.rates && json.rates.INR) ? Number(json.rates.INR) : 0;
  } catch (e) {
    return 0;
  }
}

/* All-time-high proxy: GOOGLEFINANCE has no native ATH field, so we scan WEEKLY historical
 * "high" prices from this date to today and take the MAX. Push it further back if you want —
 * just keep in mind more history = more calculation time across every symbol. */
const ATH_START_DATE = 'DATE(2000,1,1)';
// How long refreshLivePrices() waits for GOOGLEFINANCE (incl. the heavier ATH scan) to settle
// before freezing values. Bump this up if you consistently see 0.0% in %LOW ATH for stocks
// that clearly should have a real value.
const LIVE_PRICES_WAIT_MS = 15000;

// Smaller batches reduce the risk of the model cross-wiring content between stocks in the
// same call (e.g. writing one stock's rationale under a different stock's symbol) — traded
// off against total analysis time, since one batch = one 1-minute trigger fire. At 5, a
// ~120-stock portfolio takes roughly twice as long to fully analyze as it did at 10.
const AI_BATCH_SIZE = 5;
const TRIGGER_HANDLER = 'processAIBatch';

/* ---------- Provider/model slots (tried in order) ----------
 * Each slot = separate free-quota bucket. Daily-quota errors put
 * only that slot into a 4h cooldown; the next slot takes over.
 * Keys are optional except Groq/Gemini — empty-key slots are skipped. */
const AI_SLOTS = [
  { p:'Groq',       m:'llama-3.3-70b-versatile',                 key:'GROQ_API_KEY',       kind:'openai', url:'https://api.groq.com/openai/v1/chat/completions' },
  { p:'Gemini',     m:'gemini-2.0-flash',                        key:'GEMINI_API_KEY',     kind:'gemini' },
  { p:'Groq',       m:'llama-3.1-8b-instant',                    key:'GROQ_API_KEY',       kind:'openai', url:'https://api.groq.com/openai/v1/chat/completions' },
  { p:'Gemini',     m:'gemini-2.0-flash-lite',                   key:'GEMINI_API_KEY',     kind:'gemini' },
  { p:'Cerebras',   m:'llama-3.3-70b',                           key:'CEREBRAS_API_KEY',   kind:'openai', url:'https://api.cerebras.ai/v1/chat/completions' },
  { p:'OpenRouter', m:'meta-llama/llama-3.3-70b-instruct:free',  key:'OPENROUTER_API_KEY', kind:'openai', url:'https://openrouter.ai/api/v1/chat/completions' },
  { p:'Mistral',    m:'mistral-small-latest',                    key:'MISTRAL_API_KEY',    kind:'openai', url:'https://api.mistral.ai/v1/chat/completions' },
  { p:'Gemini',     m:'gemma-3-27b-it',                          key:'GEMINI_API_KEY',     kind:'gemini' }
];

/* ============================ WEB APP ============================ */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('NK Academy — Data Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function ss() { return SpreadsheetApp.openById(SHEET_ID); }

function getSheet_(name, headers) {
  let sh = ss().getSheetByName(name);
  if (!sh) {
    sh = ss().insertSheet(name);
    if (headers) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

function props_() { return PropertiesService.getScriptProperties(); }
function setMeta_(k, v) { props_().setProperty('META_' + k, v); }
function getMeta_(k) { return props_().getProperty('META_' + k) || ''; }
function nowIST_() { return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM, HH:mm'); }

/* ====================== API KEYS (Settings tab) ====================== */

function saveApiKeys(keys) {   // keys = {groq, gemini, cerebras, openrouter, mistral}
  const map = { groq:'GROQ_API_KEY', gemini:'GEMINI_API_KEY', cerebras:'CEREBRAS_API_KEY',
                openrouter:'OPENROUTER_API_KEY', mistral:'MISTRAL_API_KEY' };
  Object.keys(map).forEach(k => {
    if (keys[k] && keys[k].trim()) props_().setProperty(map[k], keys[k].trim());
  });
  return getKeyStatus();
}

function getKeyStatus() {
  const p = props_();
  return {
    groq:       !!p.getProperty('GROQ_API_KEY'),
    gemini:     !!p.getProperty('GEMINI_API_KEY'),
    cerebras:   !!p.getProperty('CEREBRAS_API_KEY'),
    openrouter: !!p.getProperty('OPENROUTER_API_KEY'),
    mistral:    !!p.getProperty('MISTRAL_API_KEY')
  };
}

/* ====================== CSV UPLOAD & PERSISTENCE ====================== */

function uploadCSV(type, csvText) {
  const rows = Utilities.parseCsv(csvText);
  if (!rows || rows.length < 2) throw new Error('CSV appears empty.');
  const now = nowIST_();

  if (type === 'SCREENER') {
    const codes = [];
    for (let i = 1; i < rows.length; i++) {
      const c = String(rows[i][0] || '').trim();
      if (c) codes.push([c]);
    }
    const sh = getSheet_(TAB_SCREENER, ['NSE_Code']);
    sh.clearContents();
    sh.getRange(1, 1).setValue('NSE_Code');
    if (codes.length) sh.getRange(2, 1, codes.length, 1).setValues(codes);
    setMeta_('SCREENER_SAVED', now);
    return { count: codes.length, saved: now };
  }

  const header = rows[0].map(h => String(h).toLowerCase());
  const iSym  = header.findIndex(h => h.indexOf('instrument') > -1);
  const iQty  = header.findIndex(h => h.indexOf('qty') > -1);
  const iCost = header.findIndex(h => h.indexOf('avg') > -1);
  if (iSym < 0 || iQty < 0 || iCost < 0)
    throw new Error('Could not find Instrument / Qty / Avg. cost columns.');

  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const sym = String(rows[i][iSym] || '').trim();
    if (!sym) continue;
    data.push([sym, Number(rows[i][iQty]) || 0, Number(rows[i][iCost]) || 0]);
  }
  const tab = (type === 'P1') ? TAB_P1 : TAB_P2;
  const sh = getSheet_(tab, ['Instrument', 'Qty', 'AvgCost']);
  sh.clearContents();
  sh.getRange(1, 1, 1, 3).setValues([['Instrument', 'Qty', 'AvgCost']]);
  if (data.length) sh.getRange(2, 1, data.length, 3).setValues(data);
  setMeta_(type + '_SAVED', now);
  return { count: data.length, saved: now };
}

/* ====================== INITIAL LOAD ====================== */

function readTab_(tab) {
  const sh = ss().getSheetByName(tab);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
}

function readAI_() {
  const ai = {};
  readTab_(TAB_AI).forEach(r => {
    const sym = String(r[0]);
    if (sym) ai[sym] = {
      suggestion: String(r[1] || ''),
      rationale:  String(r[2] || ''),
      alternate:  String(r[3] || '')
    };
  });
  return ai;
}

function readIndices_() {
  const indices = {};
  readTab_(TAB_INDICES).forEach(r => {
    const key = String(r[0]);
    if (key) indices[key] = {
      label: String(r[1] || ''),
      value: Number(r[2]) || 0,
      changePct: Number(r[3]) || 0,
      change: Number(r[4]) || 0
    };
  });
  return indices;
}

function getInitialData() {
  const p1 = readTab_(TAB_P1).map(r => ({ sym: String(r[0]), qty: Number(r[1]), avg: Number(r[2]) }));
  const p2 = readTab_(TAB_P2).map(r => ({ sym: String(r[0]), qty: Number(r[1]), avg: Number(r[2]) }));
  const screener = readTab_(TAB_SCREENER).map(r => String(r[0])).filter(Boolean);

  const prices = {};
  readTab_(TAB_PRICES).forEach(r => {
    const sym = String(r[0]);
    if (sym) prices[sym] = {
      ltp: Number(r[1]) || 0,
      dayChg: Number(r[2]) || 0,
      high52w: Number(r[3]) || 0,
      low52w: Number(r[4]) || 0,
      allTimeHigh: Number(r[5]) || 0,
      mktCap: Number(r[6]) || 0,
      pe: Number(r[7]) || 0
    };
  });

  const watchlist = JSON.parse(
    PropertiesService.getUserProperties().getProperty('WATCHLIST') || '[]');

  return {
    p1: p1, p2: p2, screener: screener,
    prices: prices, ai: readAI_(), watchlist: watchlist, indices: readIndices_(),
    meta: {
      p1Saved: getMeta_('P1_SAVED'), p2Saved: getMeta_('P2_SAVED'),
      screenerSaved: getMeta_('SCREENER_SAVED'),
      pricesSaved: getMeta_('PRICES_SAVED'), aiSaved: getMeta_('AI_SAVED')
    },
    keys: getKeyStatus(),
    aiStatus: getAIProgress().status
  };
}

/* ====================== LIVE PRICES (with 52W & ATH data) ====================== */

function refreshLivePrices() {
  const data = getInitialData();
  const symbols = uniqueSymbols_(data);
  if (!symbols.length) throw new Error('No stocks loaded. Upload CSV files first.');

  const sh = getSheet_(TAB_PRICES, ['Symbol', 'LTP', 'DayChgPct', '52WeekHigh', '52WeekLow', 'AllTimeHigh', 'MarketCap', 'PE']);
  sh.clearContents();
  sh.getRange(1, 1, 1, 8).setValues([['Symbol', 'LTP', 'DayChgPct', '52WeekHigh', '52WeekLow', 'AllTimeHigh', 'MarketCap', 'PE']]);

  // NOTE: GOOGLEFINANCE's real attribute names are "high52" / "low52" (NOT "52weekhigh"/"52weeklow" —
  // those don't exist and silently fail to the IFERROR fallback, which is why they showed 0.0% before).
  // AllTimeHigh below uses a historical WEEKLY scan since there's no native ATH attribute at all —
  // see ATH_START_DATE comment above. This is heavier than the other columns; if a symbol still
  // shows 0.0% in %LOW ATH after a real wait, that's most likely Google's documented restriction on
  // reading historical GOOGLEFINANCE data via Apps Script (may return #N/A → falls through to 0 here),
  // not a code bug — worth knowing before assuming something's broken.
  // MarketCap and PE are real-time attributes (not historical), so they behave like LTP/DAY% — no
  // wait-time or Apps-Script-read concerns. PE will legitimately come back 0/blank for loss-making
  // companies (negative or undefined P/E) — that's expected, not a bug.
  const rows = symbols.map(s => [
    s,
    '=IFERROR(GOOGLEFINANCE("NSE:' + s + '","price"), IFERROR(GOOGLEFINANCE("BOM:' + s + '","price"), 0))',
    '=IFERROR(GOOGLEFINANCE("NSE:' + s + '","changepct"), IFERROR(GOOGLEFINANCE("BOM:' + s + '","changepct"), 0))',
    '=IFERROR(GOOGLEFINANCE("NSE:' + s + '","high52"), IFERROR(GOOGLEFINANCE("BOM:' + s + '","high52"), 0))',
    '=IFERROR(GOOGLEFINANCE("NSE:' + s + '","low52"), IFERROR(GOOGLEFINANCE("BOM:' + s + '","low52"), 0))',
    '=IFERROR(MAX(QUERY(GOOGLEFINANCE("NSE:' + s + '","high",' + ATH_START_DATE + ',TODAY(),"WEEKLY"),"SELECT Col2 LABEL Col2 \'\'")), IFERROR(MAX(QUERY(GOOGLEFINANCE("BOM:' + s + '","high",' + ATH_START_DATE + ',TODAY(),"WEEKLY"),"SELECT Col2 LABEL Col2 \'\'")), 0))',
    '=IFERROR(GOOGLEFINANCE("NSE:' + s + '","marketcap"), IFERROR(GOOGLEFINANCE("BOM:' + s + '","marketcap"), 0))',
    '=IFERROR(GOOGLEFINANCE("NSE:' + s + '","pe"), IFERROR(GOOGLEFINANCE("BOM:' + s + '","pe"), 0))'
  ]);
  sh.getRange(2, 1, rows.length, 8).setValues(rows);

  // Market indices — same refresh cycle as stock prices. These are simple real-time attributes
  // (not historical like ATH), so they resolve fast and don't need their own separate wait.
  const idxSh = getSheet_(TAB_INDICES, ['Key', 'Label', 'Value', 'ChangePct', 'Change']);
  idxSh.clearContents();
  idxSh.getRange(1, 1, 1, 5).setValues([['Key', 'Label', 'Value', 'ChangePct', 'Change']]);
  const usdInrRate = fetchUsdInrRate_();
  const idxRows = INDEX_LIST.map(ix => {
    if (ix.key === 'USDINR') {
      // No day-change available from the free rate API — change/changePct left at 0.
      return [ix.key, ix.label, usdInrRate, 0, 0];
    }
    return [
      ix.key, ix.label,
      '=IFERROR(GOOGLEFINANCE("' + ix.ticker + '","price"), 0)',
      '=IFERROR(GOOGLEFINANCE("' + ix.ticker + '","changepct"), 0)',
      '=IFERROR(GOOGLEFINANCE("' + ix.ticker + '","change"), 0)'
    ];
  });
  idxSh.getRange(2, 1, idxRows.length, 5).setValues(idxRows);

  SpreadsheetApp.flush();
  Utilities.sleep(LIVE_PRICES_WAIT_MS);

  const vals = sh.getRange(2, 1, rows.length, 8).getValues();
  sh.getRange(2, 1, rows.length, 8).setValues(vals); // freeze values

  const idxVals = idxSh.getRange(2, 1, idxRows.length, 5).getValues();
  idxSh.getRange(2, 1, idxRows.length, 5).setValues(idxVals); // freeze values

  const now = nowIST_();
  setMeta_('PRICES_SAVED', now);
  const prices = {};
  vals.forEach(r => {
    prices[String(r[0])] = {
      ltp: Number(r[1]) || 0,
      dayChg: Number(r[2]) || 0,
      high52w: Number(r[3]) || 0,
      low52w: Number(r[4]) || 0,
      allTimeHigh: Number(r[5]) || 0,
      mktCap: Number(r[6]) || 0,
      pe: Number(r[7]) || 0
    };
  });
  const indices = {};
  idxVals.forEach(r => {
    indices[String(r[0])] = {
      label: String(r[1] || ''),
      value: Number(r[2]) || 0,
      changePct: Number(r[3]) || 0,
      change: Number(r[4]) || 0
    };
  });
  return { prices: prices, saved: now, indices: indices };
}

function uniqueSymbols_(data) {
  const set = {};
  data.p1.forEach(h => set[h.sym] = 1);
  data.p2.forEach(h => set[h.sym] = 1);
  data.screener.forEach(s => set[s] = 1);
  return Object.keys(set);
}

/* ============ SERVER-SIDE AI ANALYSIS (trigger-driven) ============
 * startAIAnalysis() : called from the portal button. Processes the
 *   first batch immediately, then installs a 1-minute trigger that
 *   keeps processing batches ON THE SERVER until done — the browser
 *   can be closed at any time.
 * processAIBatch()  : the trigger handler.
 * getAIProgress()   : polled by the client for status + fresh results.
 ================================================================== */

function startAIAnalysis() {
  const pend = pendingSymbols_();
  if (!pend.symbols.length) {
    setStatus_({ running:false, done:pend.total, total:pend.total, msg:'All stocks already analyzed. Use Fresh Analysis to redo.' });
    return getAIProgress();
  }
  killTriggers_();
  setStatus_({ running:true, done:pend.total - pend.symbols.length, total:pend.total, msg:'Starting…' });
  ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyMinutes(1).create();
  processAIBatch(); // first batch right away
  return getAIProgress();
}

function stopAIAnalysis() {
  killTriggers_();
  const pend = pendingSymbols_();
  setStatus_({ running:false, done:pend.total - pend.symbols.length, total:pend.total, msg:'Stopped by user.' });
  return getAIProgress();
}

function processAIBatch() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // another batch still running — skip this tick
  try {
    const pend = pendingSymbols_();
    if (!pend.symbols.length) {
      killTriggers_();
      setMeta_('AI_SAVED', nowIST_());
      setStatus_({ running:false, done:pend.total, total:pend.total, msg:'✅ Analysis complete — ' + pend.total + ' stocks.' });
      return;
    }
    const batch = pend.symbols.slice(0, AI_BATCH_SIZE);
    try {
      const results = analyzeSymbols_(batch, pend.data);
      persistAI_(results);
      const done = pend.total - pend.symbols.length + Object.keys(results).length;
      setStatus_({ running:true, done:done, total:pend.total,
        msg:'Analyzed ' + done + ' / ' + pend.total + ' — server is processing, safe to close browser.' });
    } catch (e) {
      // All providers exhausted or hard error: stop cleanly, progress is saved.
      killTriggers_();
      const done = pend.total - pend.symbols.length;
      setStatus_({ running:false, done:done, total:pend.total,
        msg:'⚠ Paused at ' + done + '/' + pend.total + ': ' + e.message + ' Click Run AI Analysis to resume.' });
    }
  } finally {
    lock.releaseLock();
  }
}

function pendingSymbols_() {
  const data = getInitialData();
  const all = uniqueSymbols_(data);
  const symbols = all.filter(s =>
    !data.ai[s] || !data.ai[s].suggestion || !data.ai[s].rationale);
  return { symbols: symbols, total: all.length, data: data };
}

function killTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === TRIGGER_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

function setStatus_(o) { o.ts = Date.now(); props_().setProperty('AI_STATUS', JSON.stringify(o)); }

function getAIProgress() {
  const s = props_().getProperty('AI_STATUS');
  return {
    status: s ? JSON.parse(s) : { running:false, done:0, total:0, msg:'' },
    ai: readAI_()
  };
}

/* Clears saved AI results for a fresh as-on-date run */
function clearAIResults() {
  killTriggers_();
  const sh = ss().getSheetByName(TAB_AI);
  if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 5).clearContent();
  setStatus_({ running:false, done:0, total:0, msg:'Results cleared.' });
  return true;
}

/* ====================== ONE BATCH → ONE COMBINED CALL ====================== */

function analyzeSymbols_(batch, data) {
  const ctx = batch.map((sym, i) => {
    const h = data.p1.find(x => x.sym === sym) || data.p2.find(x => x.sym === sym);
    const pr = data.prices[sym] || {};
    const netChg = (h && h.avg > 0 && pr.ltp) ? (((pr.ltp - h.avg) / h.avg) * 100).toFixed(1) : 'n/a';
    return (i + 1) + ') SYMBOL=' + sym + ' | held:' + (h ? 'yes qty ' + h.qty : 'no (watchlist)') +
      ' | LTP:' + (pr.ltp || 'n/a') + ' | vs cost:' + netChg + '%' +
      ' | day:' + (pr.dayChg != null ? Number(pr.dayChg).toFixed(1) + '%' : 'n/a');
  }).join('\n');

  const prompt =
    'You are an Indian equity analyst. Today is ' + new Date().toDateString() + '.\n' +
    'Below are ' + batch.length + ' completely INDEPENDENT NSE stocks, each numbered and on its own line. ' +
    'Treat each one as a separate, isolated analysis — do not let the sector, business, or news context of one ' +
    'stock bleed into your answer for another. Before writing each answer, re-read that stock\'s own SYMBOL and ' +
    'confirm your rationale/alternate actually describes THAT company\'s real business, not a neighboring one.\n' +
    'For EACH stock, give:\n' +
    '1. suggestion: exactly one of BUY, HOLD, SELL ON RALLY, EXIT NOW\n' +
    '2. rationale: ONE brief complete sentence (max 25 words) that conveys the full reasoning — sector trend, valuation, momentum, or business driver, SPECIFIC to that one company. No generic filler.\n' +
    '3. alternate: ONLY for EXIT NOW / SELL ON RALLY. Must be an NSE symbol from the EXACT SAME sector/industry as this stock ' +
    '(e.g. SYRMA for DIXON — both electronics manufacturing; INFY for TCS — both IT services). ' +
    'If you cannot name a genuinely same-sector stock that is a clear improvement, output "" — an empty string is far better than a wrong-sector guess. ' +
    'Never suggest a different-sector stock just to fill the field, and never reuse the same alternate symbol for two stocks in this batch that are not themselves in the same sector as each other.\n\n' +
    ctx + '\n\n' +
    'Respond ONLY with a JSON array, no markdown:\n' +
    '[{"symbol":"SYM","suggestion":"...","rationale":"...","alternate":"..."}]';

  const text = aiChat_(prompt, 2200);
  const out = {};
  parseJsonArray_(text).forEach(o => {
    if (!o.symbol) return;
    out[String(o.symbol).toUpperCase()] = {
      suggestion: String(o.suggestion || 'HOLD').toUpperCase(),
      rationale:  String(o.rationale || ''),
      alternate:  String(o.alternate || '')
    };
  });
  if (!Object.keys(out).length) throw new Error('Model returned unparseable output.');
  return out;
}

/* ====================== SLOT ROTATION ENGINE ====================== */

function aiChat_(prompt, maxTokens) {
  const p = props_();
  let lastErr = 'No API keys saved.';
  for (let i = 0; i < AI_SLOTS.length; i++) {
    const slot = AI_SLOTS[i];
    const key = p.getProperty(slot.key);
    if (!key) continue;
    if (slotCooldown_(slot) > Date.now()) continue;
    try {
      const text = (slot.kind === 'gemini')
        ? geminiCall_(key, slot.m, prompt, maxTokens)
        : openaiCall_(key, slot.url, slot.m, prompt, maxTokens);
      Logger.log('✓ ' + slot.p + '/' + slot.m + ' answered.');
      return text;
    } catch (e) {
      lastErr = slot.p + '/' + slot.m + ': ' + e.message;
      Logger.log('✗ ' + lastErr + ' → next slot');
    }
  }
  throw new Error('All AI providers exhausted or in cooldown. Last: ' + lastErr);
}

function slotCooldown_(slot) {
  return Number(props_().getProperty('COOLDOWN_' + slot.p + '_' + slot.m) || 0);
}
function setSlotCooldown_(slot, ms) {
  props_().setProperty('COOLDOWN_' + slot.p + '_' + slot.m, String(Date.now() + ms));
}

function openaiCall_(key, url, model, prompt, maxTokens) {
  const slot = findSlot_(url, model);
  const headers = { Authorization: 'Bearer ' + key };
  if (url.indexOf('openrouter') > -1) {
    headers['HTTP-Referer'] = 'https://script.google.com';
    headers['X-Title'] = 'NK Portal';
  }
  const body = JSON.stringify({
    model: model, temperature: 0.2, max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  });
  const res = slotFetch_(slot, url, {
    method: 'post', contentType: 'application/json',
    headers: headers, muteHttpExceptions: true, payload: body
  });
  return JSON.parse(res).choices[0].message.content;
}

function geminiCall_(key, model, prompt, maxTokens) {
  const slot = findSlot_('gemini', model);
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    model + ':generateContent?key=' + key;
  const res = slotFetch_(slot, url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens }
    })
  });
  const parsed = JSON.parse(res);
  if (!parsed.candidates || !parsed.candidates[0]) throw new Error('empty response');
  return parsed.candidates[0].content.parts[0].text;
}

function findSlot_(urlOrKind, model) {
  return AI_SLOTS.find(s => s.m === model &&
    (s.kind === 'gemini' ? urlOrKind === 'gemini' : s.url === urlOrKind)) || { p:'?', m:model };
}

/* One quick retry for per-minute limits; instant cooldown for daily quota.
 * The 1-minute trigger cycle itself provides natural pacing. */
function slotFetch_(slot, url, options) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code === 200) return resp.getContentText();
    const body = resp.getContentText();
    if (code === 429 && /check your plan and billing|PerDay|daily|quota/i.test(body)) {
      setSlotCooldown_(slot, 4 * 3600 * 1000); // daily quota — 4h cooldown
      throw new Error('daily quota exhausted (cooldown 4h)');
    }
    if ((code === 429 || code >= 500) && attempt < 2) { Utilities.sleep(12000); continue; }
    if (code === 429) {
      setSlotCooldown_(slot, 90 * 1000); // per-minute limit — brief cooldown
      throw new Error('rate limited (retrying via next slot)');
    }
    throw new Error('HTTP ' + code + ': ' + body.slice(0, 120));
  }
}

function parseJsonArray_(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('['), end = clean.lastIndexOf(']');
  return JSON.parse(clean.slice(start, end + 1));
}

function persistAI_(results) {
  const sh = getSheet_(TAB_AI, ['Symbol', 'Suggestion', 'Rationale', 'Alternate', 'Updated']);
  const existing = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach((r, i) => {
      existing[String(r[0])] = i + 2;
    });
  }
  const now = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM HH:mm');
  Object.keys(results).forEach(sym => {
    const r = results[sym];
    const row = [sym, r.suggestion, r.rationale, r.alternate, now];
    if (existing[sym]) sh.getRange(existing[sym], 1, 1, 5).setValues([row]);
    else sh.appendRow(row);
  });
}

/* ====================== WATCHLIST ====================== */

function toggleStar(sym) {
  const p = PropertiesService.getUserProperties();
  let list = JSON.parse(p.getProperty('WATCHLIST') || '[]');
  const i = list.indexOf(sym);
  if (i > -1) list.splice(i, 1); else list.push(sym);
  p.setProperty('WATCHLIST', JSON.stringify(list));
  return list;
}