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
    // Lock only the sheet write — CSV parsing above is in-memory and needs no exclusivity.
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Error('Another upload is in progress — try again in a moment.');
    try {
      const sh = getSheet_(TAB_SCREENER, ['NSE_Code']);
      sh.clearContents();
      sh.getRange(1, 1).setValue('NSE_Code');
      if (codes.length) sh.getRange(2, 1, codes.length, 1).setValues(codes);
      setMeta_('SCREENER_SAVED', now);
    } finally {
      lock.releaseLock();
    }
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

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another upload is in progress — try again in a moment.');
  try {
    const sh = getSheet_(tab, ['Instrument', 'Qty', 'AvgCost']);
    sh.clearContents();
    sh.getRange(1, 1, 1, 3).setValues([['Instrument', 'Qty', 'AvgCost']]);
    if (data.length) sh.getRange(2, 1, data.length, 3).setValues(data);
    setMeta_(type + '_SAVED', now);
  } finally {
    lock.releaseLock();
  }
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

  // Read TAB_AI once and reuse it — getAIProgress() also calls readAI_() internally, and
  // calling that full function here (just to get .status) used to read TAB_AI a second time.
  const ai = readAI_();

  return {
    p1: p1, p2: p2, screener: screener,
    prices: prices, ai: ai, watchlist: watchlist, indices: readIndices_(),
    meta: {
      p1Saved: getMeta_('P1_SAVED'), p2Saved: getMeta_('P2_SAVED'),
      screenerSaved: getMeta_('SCREENER_SAVED'),
      pricesSaved: getMeta_('PRICES_SAVED'), aiSaved: getMeta_('AI_SAVED')
    },
    keys: getKeyStatus(),
    aiStatus: getAIStatus_()
  };
}

/* ====================== LIVE PRICES (with 52W & ATH data) ====================== */

function refreshLivePrices() {
  const data = getInitialData();
  const symbols = uniqueSymbols_(data);
  if (!symbols.length) throw new Error('No stocks loaded. Upload CSV files first.');

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
  // Formula strings + the USD/INR fetch are built in-memory before any locking — no need for
  // exclusivity here, and the external HTTP call must never happen while holding the lock.
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

  // Lock #1: the initial clear + formula write only. Released before the long GOOGLEFINANCE
  // settle-wait below so this doesn't block other locked operations (e.g. an AI batch tick)
  // for the full 15s+ — see Section 23 of architect-prompt.txt.
  let sh, idxSh;
  const lock1 = LockService.getScriptLock();
  if (!lock1.tryLock(10000)) throw new Error('Another price refresh is already running — try again in a moment.');
  try {
    sh = getSheet_(TAB_PRICES, ['Symbol', 'LTP', 'DayChgPct', '52WeekHigh', '52WeekLow', 'AllTimeHigh', 'MarketCap', 'PE']);
    sh.clearContents();
    sh.getRange(1, 1, 1, 8).setValues([['Symbol', 'LTP', 'DayChgPct', '52WeekHigh', '52WeekLow', 'AllTimeHigh', 'MarketCap', 'PE']]);
    sh.getRange(2, 1, rows.length, 8).setValues(rows);

    // Market indices — same refresh cycle as stock prices. These are simple real-time attributes
    // (not historical like ATH), so they resolve fast and don't need their own separate wait.
    idxSh = getSheet_(TAB_INDICES, ['Key', 'Label', 'Value', 'ChangePct', 'Change']);
    idxSh.clearContents();
    idxSh.getRange(1, 1, 1, 5).setValues([['Key', 'Label', 'Value', 'ChangePct', 'Change']]);
    idxSh.getRange(2, 1, idxRows.length, 5).setValues(idxRows);

    SpreadsheetApp.flush();
  } finally {
    lock1.releaseLock();
  }

  Utilities.sleep(LIVE_PRICES_WAIT_MS); // unlocked — just waiting for GOOGLEFINANCE to settle

  // Lock #2: the freeze (read-back + rewrite as static values) — the other critical write section.
  let vals, idxVals;
  const lock2 = LockService.getScriptLock();
  if (!lock2.tryLock(10000)) throw new Error('Another price refresh is already running — try again in a moment.');
  try {
    vals = sh.getRange(2, 1, rows.length, 8).getValues();
    sh.getRange(2, 1, rows.length, 8).setValues(vals); // freeze values

    idxVals = idxSh.getRange(2, 1, idxRows.length, 5).getValues();
    idxSh.getRange(2, 1, idxRows.length, 5).setValues(idxVals); // freeze values
  } finally {
    lock2.releaseLock();
  }

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
  processAIBatch(pend); // first batch right away — reuse the pending-symbols data computed above
                          // instead of making processAIBatch() re-run getInitialData() from scratch
  return getAIProgress();
}

function stopAIAnalysis() {
  killTriggers_();
  const pend = pendingSymbols_();
  setStatus_({ running:false, done:pend.total - pend.symbols.length, total:pend.total, msg:'Stopped by user.' });
  return getAIProgress();
}

// precomputedPend (optional): when startAIAnalysis() calls this inline for the first batch, it
// passes its own already-fresh pendingSymbols_() result to avoid a second getInitialData() call.
// When Apps Script invokes this as the time-driven trigger handler, it's called with a time-event
// object instead (not this shape — no .symbols field), so the check below falls back correctly.
function processAIBatch(precomputedPend) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // another batch still running — skip this tick
  try {
    const pend = (precomputedPend && precomputedPend.symbols) ? precomputedPend : pendingSymbols_();
    if (!pend.symbols.length) {
      killTriggers_();
      setMeta_('AI_SAVED', nowIST_());
      setStatus_({ running:false, done:pend.total, total:pend.total, msg:'✅ Analysis complete — ' + pend.total + ' stocks.' });
      return;
    }
    const batch = pend.symbols.slice(0, AI_BATCH_SIZE);
    try {
      const rawResults = analyzeSymbols_(batch, pend.data);
      // DATA → AI ANALYSIS → STRUCTURED AI RESPONSE → DETERMINISTIC VALIDATION → SAVE
      // (architect-prompt.txt Section 4). Never persist a raw AI response as-is.
      Object.keys(rawResults).forEach(sym => {
        forceNoDataOverride_(sym, rawResults[sym], pend.data.prices);
        validateEntry_(sym, rawResults[sym]);
      });
      const results = applyBatchAltConsistency_(rawResults, pend.data.ai);
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

// Just the status property, no sheet read — shared by getInitialData() (which already has its
// own `ai` from a single readAI_() call) and getAIProgress() (which needs both, see below).
function getAIStatus_() {
  const s = props_().getProperty('AI_STATUS');
  return s ? JSON.parse(s) : { running:false, done:0, total:0, msg:'' };
}

function getAIProgress() {
  return {
    status: getAIStatus_(),
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

// Fixed, controlled vocabulary for "sector" / "alt_sector" (architect-prompt.txt Section 9).
// Forcing the model to pick from this exact list — rather than free text — is what makes
// sector-comparability checkable by plain string equality in validateEntry_() below, with no
// fuzzy matching or extra AI round-trip needed.
const SECTOR_LIST = [
  'IT Services','ER&D','Auto','Auto Components','Banking','NBFC','Insurance','Pharma',
  'Healthcare Services','FMCG','Tobacco','Consumer Durables','Retail','Jewellery','Paints','Chemicals',
  'Agrochemicals','Cement','Building Materials','Metals & Mining','Power','Electrical Equipment',
  'Capital Goods','Defence','Railways','EMS','Semiconductor','Telecom Equipment','Telecom Services',
  'Renewables','Oil & Gas','Utilities','Financial Market Infrastructure','Hotels & Hospitality',
  'Aviation','Logistics & Ports','Real Estate','Media & Entertainment','Textiles',
  'Internet & E-commerce','Beverages','Diversified Conglomerate','Other'
];

// Ground-truth overrides for specific symbol pairs already observed slipping past the AI's own
// sector self-report (e.g. OLAELEC and HAVELLS both got labeled the same sector despite being
// EV/auto vs electrical equipment). When BOTH a stock and its ALT are in this map, their mapped
// values are used INSTEAD of the AI's self-reported sector/alt_sector for comparison — this beats
// the AI's own report even if it claims a match. Anything not in the map falls back to the AI's
// self-report as before. Add pairs here as new mismatches are observed in practice.
const KNOWN_SECTOR_MAP = {
  'OLAELEC': 'Auto', 'HAVELLS': 'Electrical Equipment',
  'PGHH': 'FMCG', 'DRREDDY': 'Pharma',
  'BANCOINDIA': 'Auto Components', 'BAJFINANCE': 'NBFC',
  'INDUSTOWER': 'Telecom Equipment', 'BHARTIARTL': 'Telecom Services',
  'ADANIENT': 'Diversified Conglomerate', 'ULTRACEMCO': 'Cement',
  'GODFRYPHLP': 'Tobacco', 'BRITANNIA': 'FMCG',
  'JWL': 'Railways', 'TBZ': 'Jewellery',
  'TMPV': 'Auto', 'TMCV': 'Auto',
  'RAINBOW': 'Healthcare Services',
  'KALAMANDIR': 'Retail', 'GRASIM': 'Diversified Conglomerate',
  'TATATECH': 'ER&D', 'MOTHSON': 'Auto Components', 'MOTHERSON': 'Auto Components',
  // Confirmed AI company-identity confusion, not just a sector mismatch — e.g. ACE's rationale
  // literally described "Aarti Industries" (a different company entirely), and APARINDS's
  // rationale described a "cement business" it doesn't have. Ground truth here corrects that.
  'ACE': 'Capital Goods', 'APARINDS': 'Electrical Equipment',
  // JSL = Jindal Stainless (steel), but the AI self-labeled it "NBFC" and suggested SHRIRAMFIN
  // (a real NBFC) as its ALT — same self-mislabel pattern JWL had with "Jewellery".
  'JSL': 'Metals & Mining', 'SHRIRAMFIN': 'NBFC',
  // Self-mislabels observed in the run of 2026-08-11 — each of these had a rationale describing
  // the wrong industry entirely (BALKRISIND as "gold and silver jewelry", UNOMINDA as "IT
  // Services", TITAN as "FMCG", PNGJL as "Metals & Mining", KPITTECH as "EMS", PIDILITIND as
  // "Engineering", HEROMOTOCO as "Auto Components", OFSS as "ER&D").
  'BALKRISIND': 'Auto Components', 'UNOMINDA': 'Auto Components',
  'TITAN': 'Jewellery', 'PNGJL': 'Jewellery',
  'KPITTECH': 'ER&D', 'PIDILITIND': 'Chemicals',
  'HEROMOTOCO': 'Auto', 'OFSS': 'IT Services',
  'ITCHOTELS': 'Hotels & Hospitality', 'BLACKROSE': 'Chemicals',
  'ASTRAL': 'Building Materials', 'APLAPOLLO': 'Building Materials',
  'COALINDIA': 'Metals & Mining', 'TRENT': 'Retail', 'BANDHANBNK': 'Banking',
  // ALT-side counterparts, so the either-side comparison has ground truth on both ends.
  'HINDALCO': 'Metals & Mining', 'HINDZINC': 'Metals & Mining',
  'ASHOKLEY': 'Auto', 'EICHERMOT': 'Auto', 'TVSMOTOR': 'Auto', 'MARUTI': 'Auto',
  'INDUSINDBK': 'Banking', 'KOTAKBANK': 'Banking', 'ICICIBANK': 'Banking', 'HDFCBANK': 'Banking',
  'NTPC': 'Power', 'SJVN': 'Renewables', 'JSWENERGY': 'Power',
  // LTM = LTM Ltd (Larsen & Toubro Infotech), NSE: LTM / BSE: 540005 — IT services. Confirmed
  // from Screener.in. Earlier runs mislabeled it as a luxury/consumer brand ("Luxury demand
  // strong"), though a later run did correctly identify the L&T connection.
  'LTM': 'IT Services',
  'LTIM': 'IT Services', 'LTI': 'IT Services', 'INFY': 'IT Services', 'TCS': 'IT Services',
  'HINDUNILVR': 'FMCG', 'NESTLEIND': 'FMCG', 'TATACONSUM': 'FMCG',
  'TATAELXSI': 'ER&D', 'SYRMA': 'EMS', 'DIXON': 'EMS'
};

// Extra business-context notes for symbols the AI providers have been observed getting confused
// about — usually a recent corporate action their training data may predate or know thinly.
// Injected into the prompt ONLY for a symbol that appears in a given batch, so this stays cheap
// and doesn't bloat every other stock's context. TMPV/TMCV: Tata Motors' Nov 2025 demerger split
// the company into passenger-vehicle+EV+JLR (TMPV) and commercial-vehicle (TMCV) halves — a model
// unaware of this split has nothing real to reason from and is more likely to hallucinate.
const SYMBOL_CONTEXT_HINTS = {
  'TMPV': 'TMPV = Tata Motors Passenger Vehicles Ltd, the passenger-vehicle + EV + JLR half of the Nov 2025 Tata Motors demerger. Auto sector. The old combined TATAMOTORS listing no longer exists — do not reference or suggest it.',
  'TMCV': 'TMCV = the commercial-vehicle half of the Nov 2025 Tata Motors demerger (now carrying the Tata Motors Limited name). Auto sector. The old combined TATAMOTORS listing no longer exists — do not reference or suggest it.',
  // Identity-confusion cases observed in real runs: the model wrote rationales about a
  // DIFFERENT company than the ticker (Aarti Industries for ACE; construction equipment for
  // DIVISLAB; life insurance for ZYDUSLIFE; a cement business for APARINDS). ALT validation
  // can't catch a wrong-company rationale on a BUY/HOLD call — this hint is the only lever.
  'ACE': 'ACE = Action Construction Equipment Ltd — cranes and construction machinery (Capital Goods). NOT Aarti Industries or any chemicals company.',
  'APARINDS': 'APARINDS = Apar Industries Ltd — conductors, cables and specialty oils (Electrical Equipment). NOT a cement company.',
  'DIVISLAB': 'DIVISLAB = Divi\'s Laboratories Ltd — pharmaceutical APIs and custom synthesis (Pharma). NOT construction equipment.',
  'ZYDUSLIFE': 'ZYDUSLIFE = Zydus Lifesciences Ltd — pharmaceuticals (Pharma). NOT a life-insurance company despite the name.'
};

function analyzeSymbols_(batch, data) {
  const ctx = batch.map((sym, i) => {
    const h = data.p1.find(x => x.sym === sym) || data.p2.find(x => x.sym === sym);
    const pr = data.prices[sym] || {};
    const netChg = (h && h.avg > 0 && pr.ltp) ? (((pr.ltp - h.avg) / h.avg) * 100).toFixed(1) : 'n/a';
    // Feed KNOWN_SECTOR_MAP ground truth INTO the prompt, not just use it as a post-check.
    // Post-validation can only blank a bad ALT; it can't fix a rationale written about the wrong
    // business (observed: PGHH correctly ALT-blanked but still described as "Jewellery sector").
    // Telling the model the sector upfront is the only lever that reaches rationale quality.
    const known = KNOWN_SECTOR_MAP[sym];
    const sectorNote = known ? ' | SECTOR (authoritative — use this, do not infer your own): ' + known : '';
    const hint = SYMBOL_CONTEXT_HINTS[sym] ? ' | NOTE: ' + SYMBOL_CONTEXT_HINTS[sym] : '';
    return (i + 1) + ') SYMBOL=' + sym + sectorNote + hint + ' | held:' + (h ? 'yes qty ' + h.qty : 'no (watchlist)') +
      ' | LTP:' + (pr.ltp || 'n/a') + ' | vs cost:' + netChg + '%' +
      ' | day:' + (pr.dayChg != null ? Number(pr.dayChg).toFixed(1) + '%' : 'n/a');
  }).join('\n');

  const prompt =
    'You are an Indian equity analyst. Today is ' + new Date().toDateString() + '.\n' +
    'Below are ' + batch.length + ' completely INDEPENDENT NSE stocks, each numbered and on its own line. ' +
    'Treat each one as a separate, isolated analysis — do not let the sector, business, or news context of one ' +
    'stock bleed into your answer for another. Before writing each answer, re-read that stock\'s own SYMBOL and ' +
    'confirm your rationale/alternate actually describes THAT company\'s real business, not a neighboring one. ' +
    'If a stock shows LTP:n/a, there is no reliable price data for it — say so plainly in the rationale rather ' +
    'than inventing a confident-sounding call.\n' +
    'For EACH stock, give:\n' +
    '1. suggestion: exactly one of BUY, HOLD, SELL ON RALLY, EXIT NOW\n' +
    '2. rationale: ONE brief complete sentence (max 25 words) that conveys the full reasoning — sector trend, valuation, momentum, or business driver, SPECIFIC to that one company. No generic filler.\n' +
    '3. sector: this company\'s own sector — pick EXACTLY ONE label from this fixed list, copied exactly as written: ' + SECTOR_LIST.join(', ') + '\n' +
    '4. alternate: ONLY for EXIT NOW / SELL ON RALLY. Must be a REAL NSE-listed company\'s exact ticker symbol, from ' +
    'the EXACT SAME sector as this stock (e.g. SYRMA for DIXON — both EMS; INFY for TCS — both IT Services). ' +
    'Only use a ticker you are genuinely confident is real and currently listed — never invent a plausible-sounding ' +
    'name or generic term (e.g. "BLUECHIP" is not a company). If you cannot name a genuinely same-sector, real, ' +
    'listed stock that is a clear improvement, output "" — an empty string is far better than a wrong or invented guess. ' +
    'Never suggest a different-sector stock just to fill the field, and never reuse the same alternate symbol for two stocks in this batch that are not themselves in the same sector as each other.\n' +
    '5. alt_sector: ONLY when alternate is non-empty — that alternate\'s own sector, from the SAME fixed list, and it MUST be identical to your "sector" answer above; else ""\n\n' +
    ctx + '\n\n' +
    'Respond ONLY with a JSON array, no markdown:\n' +
    '[{"symbol":"SYM","suggestion":"...","rationale":"...","sector":"...","alternate":"...","alt_sector":"..."}]';

  return aiChat_(prompt, 2200, parseAnalysisResponse_);
}

// Turns one provider's raw text into the {SYMBOL: {suggestion,rationale,sector,alternate,altSector}}
// map. Passed into aiChat_() as its parseResponse callback so a malformed/empty response is caught
// by the SAME per-slot try/catch that already handles HTTP/network failures — this slot is
// skipped and rotation moves to the next one, instead of the parse error escaping the loop
// and failing the whole batch.
//
// NOTE: sector/altSector are runtime-only validation signals (see DETERMINISTIC VALIDATION LAYER
// below) — persistAI_() only ever reads .suggestion/.rationale/.alternate, so nothing here changes
// the AI_Analysis sheet schema or the AI CALL/RATIONALE/ALT columns the UI already renders.
function parseAnalysisResponse_(text) {
  const out = {};
  parseJsonArray_(text).forEach(o => {
    if (!o.symbol) return;
    out[String(o.symbol).toUpperCase()] = {
      suggestion: String(o.suggestion || 'HOLD').toUpperCase(),
      rationale:  String(o.rationale || ''),
      sector:     String(o.sector || ''),
      alternate:  String(o.alternate || ''),
      altSector:  String(o.alt_sector || '')
    };
  });
  if (!Object.keys(out).length) throw new Error('Model returned unparseable output.');
  return out;
}

/* ====================== DETERMINISTIC VALIDATION LAYER ======================
 * architect-prompt.txt Sections 4/6/7/9/11: the LLM proposes, this code decides what's
 * actually safe to save. Runs once per stock (validateEntry_), right after the AI response
 * is parsed and before anything is persisted. */

const ALLOWED_CALLS = ['BUY', 'HOLD', 'SELL ON RALLY', 'EXIT NOW'];

// Deliberately small, conservative phrase lists — only meant to catch UNAMBIGUOUS
// contradictions matching Section 6's own examples, not to act as a real sentiment model.
// Anything less clear-cut is left alone rather than risk a false-positive downgrade.
const STRONG_POSITIVE_PHRASES = [
  'strong fundamentals', 'attractive long-term', 'attractive valuation', 'robust growth',
  'excellent prospects', 'buy the dip', 'compelling opportunity', 'best-in-class'
];
const STRONG_NEGATIVE_PHRASES = [
  'severe balance-sheet', 'going concern', 'fraud', 'bankruptcy', 'insolvency',
  'accounting irregularities', 'promoter pledge crisis', 'auditor resignation'
];

function isObviouslyContradictory_(suggestion, rationale) {
  const r = String(rationale || '').toLowerCase();
  const hasPositive = STRONG_POSITIVE_PHRASES.some(p => r.indexOf(p) > -1);
  const hasNegative = STRONG_NEGATIVE_PHRASES.some(p => r.indexOf(p) > -1);
  if ((suggestion === 'EXIT NOW' || suggestion === 'SELL ON RALLY') && hasPositive && !hasNegative) return true;
  if (suggestion === 'BUY' && hasNegative && !hasPositive) return true;
  return false;
}

function normalizeTicker_(t) {
  return String(t || '').trim().toUpperCase().replace(/[^A-Z0-9&\-]/g, '');
}
function isPlausibleTicker_(t) {
  return /^[A-Z0-9&\-]{2,20}$/.test(t);
}
function normalizeSector_(s) {
  return String(s || '').trim().toLowerCase();
}

// Generic investment jargon the model can output in the ALT slot that LOOKS ticker-shaped
// (passes isPlausibleTicker_) but is not a real company — e.g. "BLUECHIP" is a finance term,
// not an NSE symbol. This does NOT catch a garbled-but-plausible real name (e.g. a misspelled
// ticker) — that needs an actual ticker database, which isn't available here; known residual risk.
const GENERIC_NONTICKER_TERMS = [
  'BLUECHIP', 'LARGECAP', 'MIDCAP', 'SMALLCAP', 'GROWTH', 'VALUE', 'QUALITY',
  'DIVIDEND', 'DEFENSIVE', 'CYCLICAL', 'MOMENTUM', 'SECTOR', 'INDEX', 'BENCHMARK'
];

// Tickers that were real once but no longer trade under that symbol — the models' training data
// predates the corporate action, so they keep suggesting them. TATAMOTORS: replaced by the
// TMPV/TMCV pair in the Nov 2025 demerger (observed suggested as ALT for TMPV, MARUTI, HYUNDAI,
// BAJAJ-AUTO across runs). Add here when a listing is renamed/merged/delisted.
const KNOWN_STALE_TICKERS = ['TATAMOTORS'];

// Observed hallucinated or misspelled ALT symbols — each is a near-miss of a real company, so
// isPlausibleTicker_() passes them on format and only explicit knowledge catches them. Listing
// the WRONG form here (the right form, where one exists, is noted alongside) — this is not a
// general solution to invented tickers (that needs a real NSE symbol database), just a block on
// the specific bad values this system has actually produced.
const KNOWN_INVALID_TICKERS = [
  'PIRAMLABS',    // no such NSE symbol (Piramal entities are PEL / PPLPHARMA)
  'INDUSLANDBK',  // misspelling of INDUSINDBK
  'AJANTPHD',     // Ajanta Pharma is AJANTPHARM
  'BALKRISHNA',   // Balkrishna Industries is BALKRISIND
  'MOTHSON',      // Samvardhana Motherson is MOTHERSON
  'BLUEDEXT'      // unidentifiable; appeared as KWIL's ALT in an earlier run
];

// SECTOR_LIST has no ETF/fund/basket category, so an ETF could get labeled "Other" and falsely
// pass the sector-match check against something unrelated. There is no single reliable NSE-wide
// ETF ticker pattern: "BEES" suffix is safe (used broadly, e.g. GOLDBEES — no known real equity
// is named that way), but prefix/substring guesses are NOT — this portfolio itself proves it:
// a "UTI" prefix rule would wrongly flag UTIAMC (a real listed asset-management equity, not a
// fund), and a "SOLAR" substring rule would wrongly flag SOLARINDS (a real explosives/defence
// manufacturer, unrelated to solar energy or funds). So: pattern-match the safe suffix, and keep
// an explicit, manually-verified list for everything else. UPDATE THIS LIST if a new ETF/fund
// is added to P1/P2/Screener — a missed one silently falls back to the 'Other'-bucket gap.
const KNOWN_ETF_SYMBOLS = ['GOLDBEES', 'MAFANG', 'UTIGOLD'];

function isEtf_(sym) {
  const s = normalizeTicker_(sym);
  return /BEES$/.test(s) || KNOWN_ETF_SYMBOLS.indexOf(s) > -1;
}

// Observed phrasing keeps varying run to run ("LTP is not available", "price is not available",
// "Unreliable price data" — none of which matched the original 3-phrase list), so this needs to
// stay broad rather than an exact-phrase list. Low false-positive risk: this only fires when the
// symbol already has a REAL positive LTP, so the worst case is an unnecessary-but-safe downgrade
// to HOLD, never a dangerous one.
const NO_DATA_CLAIM_PATTERNS = [
  'no reliable price data', 'no live price data', 'no price data', 'no reliable data',
  'unreliable price data', 'unreliable data', 'price is not available', 'ltp is not available',
  'price data is not available', 'lack of reliable price', 'no clear market value'
];

// Section 26 (data integrity), tightly scoped as a validation rule. Two directions:
//  - A stock with no live price has nothing real for the AI to reason about, and was observed
//    hallucinating a different confident-sounding call/ALT each run for exactly such symbols.
//  - The inverse also occurs: the AI sometimes claims "no reliable price data" in its rationale
//    even when a real LTP exists (observed on BLS/GODFRYPHLP/IRCON) — a call built on a rationale
//    that's factually wrong about a verifiable fact can't be trusted, so it's downgraded too.
// Either way, this always overrides whatever the AI said — never left as the model's own output.
function forceNoDataOverride_(sym, entry, prices) {
  const pr = prices[sym];
  const hasRealPrice = pr && pr.ltp > 0;
  if (!hasRealPrice) {
    entry.suggestion = 'HOLD';
    entry.rationale = 'No live price data available for this symbol — AI analysis skipped pending a real quote.';
    entry.alternate = '';
    entry.altSector = '';
  } else {
    const r = String(entry.rationale || '').toLowerCase();
    if (NO_DATA_CLAIM_PATTERNS.some(p => r.indexOf(p) > -1)) {
      // Log the ORIGINAL rationale before replacing it — the sheet only keeps the replacement,
      // so this log line is the only surviving evidence for auditing whether the pattern match
      // was a genuine false no-data claim or an over-broad match. Check the Executions panel.
      Logger.log('⚠ ' + sym + ': rationale falsely claims no price data (LTP=' + pr.ltp + ') — downgraded to HOLD. Original rationale was: "' + entry.rationale + '"');
      entry.suggestion = 'HOLD';
      entry.rationale = 'AI response was inconsistent with available price data (LTP ' + pr.ltp + ') — treated as HOLD pending re-analysis.';
      entry.alternate = '';
      entry.altSector = '';
    }
  }
  return entry;
}

function validateEntry_(sym, entry) {
  // 1) suggestion must be one of the 4 known values.
  if (ALLOWED_CALLS.indexOf(entry.suggestion) === -1) {
    Logger.log('⚠ ' + sym + ': unknown suggestion "' + entry.suggestion + '" — downgraded to HOLD');
    entry.suggestion = 'HOLD';
  }

  // 2) ALT is only ever meaningful for EXIT NOW / SELL ON RALLY (Section 7, rule 1).
  if (entry.suggestion !== 'EXIT NOW' && entry.suggestion !== 'SELL ON RALLY') {
    entry.alternate = '';
    entry.altSector = '';
  }

  // 3) Call ↔ rationale consistency (Section 6).
  if (isObviouslyContradictory_(entry.suggestion, entry.rationale)) {
    Logger.log('⚠ ' + sym + ': suggestion/rationale contradiction — downgraded to HOLD. Rationale: ' + entry.rationale);
    entry.suggestion = 'HOLD';
    entry.alternate = '';
    entry.altSector = '';
  }

  // 4) ALT ticker sanity + self-reference + generic-jargon + stale-listing rejection (Section 11).
  if (entry.alternate) {
    const norm = normalizeTicker_(entry.alternate);
    if (!norm || norm === sym || !isPlausibleTicker_(norm) ||
        GENERIC_NONTICKER_TERMS.indexOf(norm) > -1 || KNOWN_STALE_TICKERS.indexOf(norm) > -1 ||
        KNOWN_INVALID_TICKERS.indexOf(norm) > -1) {
      Logger.log('⚠ ' + sym + ': invalid/self-referencing/non-ticker/stale ALT "' + entry.alternate + '" — blanked');
      entry.alternate = '';
      entry.altSector = '';
    } else {
      entry.alternate = norm;
    }
  }

  // 5) Block ALT entirely for non-equity instruments (ETFs/funds/baskets) — "comparable
  //    alternative" doesn't meaningfully apply when either side is one of these, and
  //    SECTOR_LIST has no real category for them (see isEtf_() comment).
  if (entry.alternate && (isEtf_(sym) || isEtf_(entry.alternate))) {
    Logger.log('⚠ ' + sym + ': ETF/fund involved (this stock or its ALT) — blanked');
    entry.alternate = '';
    entry.altSector = '';
  }

  // 6) Sector comparability (Section 9). For EACH side independently, ground truth from
  //    KNOWN_SECTOR_MAP wins if that symbol is listed; otherwise falls back to the AI's own
  //    self-reported sector/alt_sector for that side. This is deliberately NOT "both sides must
  //    be in the map" — a stock the AI systematically misidentifies (e.g. JWL self-reported as
  //    "Jewellery" instead of Railways) will keep passing its OWN self-report against any new
  //    hallucinated ALT that happens to share that same wrong label, no matter how many such
  //    ALTs get individually added to the map. Comparing ground truth against whatever's
  //    available for the other side closes that whack-a-mole gap without needing every bad ALT
  //    pre-listed — confirmed against the JWL→PCJEWELLER case (PCJEWELLER was never in the map).
  if (entry.alternate) {
    const symSector = KNOWN_SECTOR_MAP[sym] || entry.sector;
    const altSectorVal = KNOWN_SECTOR_MAP[entry.alternate] || entry.altSector;
    if (!symSector || !altSectorVal || normalizeSector_(symSector) !== normalizeSector_(altSectorVal)) {
      Logger.log('⚠ ' + sym + ': ALT ' + entry.alternate + ' sector mismatch (' + symSector + ' vs ' + altSectorVal + ') — blanked');
      entry.alternate = '';
      entry.altSector = '';
    }
  }

  return entry;
}

// Simple cycle detection over a sym->alternate adjacency map. Returns the set of symbols that
// are part of at least one cycle (A→B→A, A→B→C→A, etc). Runs a walk from every node, which is
// enough to find every cycle in aggregate even though a walk starting outside a cycle won't
// detect it — a walk starting from a member of that same cycle always will, and every cycle
// member is itself iterated as a starting point.
function findCycleMembers_(edges) {
  const members = {};
  Object.keys(edges).forEach(start => {
    const seen = [];
    const visited = {};
    let cur = start;
    while (edges[cur] && !visited[cur]) {
      visited[cur] = true;
      seen.push(cur);
      cur = edges[cur];
      if (cur === start) { seen.forEach(s => members[s] = 1); break; }
    }
  });
  return Object.keys(members);
}

// architect-prompt.txt Sections 8 + 10: batch-level ALT consistency, checked against this
// batch's results PLUS already-persisted AI_Analysis data (so an ALT pointing at a stock
// analyzed in an earlier batch is still caught, not just ones within this same batch).
function applyBatchAltConsistency_(batchResults, existingAi) {
  const combined = {};
  Object.keys(existingAi || {}).forEach(sym => { combined[sym] = existingAi[sym]; });
  Object.keys(batchResults).forEach(sym => { combined[sym] = batchResults[sym]; }); // batch wins

  // (a) Target's own latest call is itself EXIT NOW / SELL ON RALLY.
  Object.keys(batchResults).forEach(sym => {
    const e = batchResults[sym];
    if (!e.alternate) return;
    const target = combined[e.alternate];
    if (target && (target.suggestion === 'EXIT NOW' || target.suggestion === 'SELL ON RALLY')) {
      Logger.log('⚠ ' + sym + ': ALT ' + e.alternate + ' is itself ' + target.suggestion + ' — blanked');
      e.alternate = ''; e.altSector = '';
    }
  });

  // (b) Circular ALT chains — blank every symbol in any detected cycle.
  const edges = {};
  Object.keys(combined).forEach(sym => {
    const e = combined[sym];
    if (e && e.alternate) edges[sym] = e.alternate;
  });
  findCycleMembers_(edges).forEach(sym => {
    if (batchResults[sym] && batchResults[sym].alternate) {
      Logger.log('⚠ ' + sym + ': part of a circular ALT chain — blanked');
      batchResults[sym].alternate = ''; batchResults[sym].altSector = '';
    }
  });

  // (c) Same ALT reused across stocks from genuinely different sectors — generic-fallback signal
  //     (Section 10). Per-stock sector-mismatch is already caught in validateEntry_(); this is a
  //     defense-in-depth catch for cases where the model's own sector label for the same ALT
  //     drifted across separate calls.
  const usersByAlt = {};
  Object.keys(combined).forEach(sym => {
    const e = combined[sym];
    if (e && e.alternate) {
      (usersByAlt[e.alternate] = usersByAlt[e.alternate] || []).push({ sym: sym, sector: normalizeSector_(e.sector) });
    }
  });
  Object.keys(usersByAlt).forEach(alt => {
    const users = usersByAlt[alt];
    if (users.length < 2) return;
    const distinctSectors = {};
    users.forEach(u => { if (u.sector) distinctSectors[u.sector] = 1; });
    if (Object.keys(distinctSectors).length > 1) {
      users.forEach(u => {
        if (batchResults[u.sym] && batchResults[u.sym].alternate === alt) {
          Logger.log('⚠ ' + u.sym + ': ALT ' + alt + ' reused across mismatched sectors — blanked');
          batchResults[u.sym].alternate = ''; batchResults[u.sym].altSector = '';
        }
      });
    }
  });

  return batchResults;
}

/* ====================== SLOT ROTATION ENGINE ====================== */

// parseResponse (optional): called on each slot's raw text before it's accepted. Throwing
// from it (e.g. malformed JSON) is treated exactly like an API/network failure for that slot —
// caught below, logged, and rotation continues to the next slot. Only returns raw text if omitted.
function aiChat_(prompt, maxTokens, parseResponse) {
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
      const result = parseResponse ? parseResponse(text) : text;
      Logger.log('✓ ' + slot.p + '/' + slot.m + ' answered.');
      return result;
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

// Reads the existing AI_Analysis block once, applies this batch's results to it in memory, then
// writes back in at most 2 bulk setValues() calls — one for updates to existing rows (rewritten
// as a single contiguous block), one for newly-appended symbols — instead of up to AI_BATCH_SIZE
// separate per-row writes. A single call isn't possible for the update case because matched rows
// can be scattered anywhere in the sheet and setValues() requires one contiguous range.
function persistAI_(results) {
  const sh = getSheet_(TAB_AI, ['Symbol', 'Suggestion', 'Rationale', 'Alternate', 'Updated']);
  const now = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM HH:mm');

  const lastRow = sh.getLastRow();
  const existingRows = (lastRow > 1) ? sh.getRange(2, 1, lastRow - 1, 5).getValues() : [];
  const existingIndex = {}; // symbol -> index into existingRows
  existingRows.forEach((r, i) => { existingIndex[String(r[0])] = i; });

  const newRows = [];
  Object.keys(results).forEach(sym => {
    const r = results[sym];
    const row = [sym, r.suggestion, r.rationale, r.alternate, now];
    if (sym in existingIndex) existingRows[existingIndex[sym]] = row; // update in-memory copy
    else newRows.push(row); // collect for a single bulk append
  });

  if (existingRows.length) sh.getRange(2, 1, existingRows.length, 5).setValues(existingRows);
  if (newRows.length) sh.getRange(sh.getLastRow() + 1, 1, newRows.length, 5).setValues(newRows);
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