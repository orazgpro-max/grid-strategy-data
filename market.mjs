/** Public, unsigned Binance Spot data. No account or trading endpoints.
 * ATH excludes the first traded 1m candle of this Binance pair. The rest of
 * the first day is retained. This is not a worldwide asset ATH. Migrations are not
 * automatically joined or adjusted. Times in the exported record are UTC ms.
 * Sources: https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md
 * https://github.com/binance/binance-spot-api-docs/blob/master/filters.md
 * https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md
 */
const DAY = 86400000;
const HOUR = 3600000;
const MINUTE = 60000;
const PRIMARY = 'https://api.binance.com';
const FALLBACK = 'https://data-api.binance.vision';
const PATHS = new Set(['/api/v3/exchangeInfo', '/api/v3/ticker/price', '/api/v3/ticker/24hr', '/api/v3/ticker/bookTicker', '/api/v3/klines', '/api/v3/referencePrice', '/api/v3/avgPrice']);
const CACHE_PREFIX = 'grid-binance-daily-v2:';
const CACHE_AGE = 30 * DAY;
const LIQUIDITY_REUSE_AGE = 60000;
export const ATH_SCOPE = 'Максимум истории пары Binance (USDT) без первой минутной свечи листинга, не мировой максимум монеты';

export class MarketDataError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'MarketDataError'; this.code = code; Object.assign(this, details); }
}
const failure = (code, message, details) => new MarketDataError(code, message, details);
const positive = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const number = (value, field, allowZero = false) => {
  if (!(positive(value) || (allowZero && (value === 0 || /^0(?:\.0+)?$/.test(String(value)))))) throw failure('INVALID_RESPONSE', `Binance вернул неверное значение: ${field}.`);
  return Number(value);
};
function normalizeSymbol(value) {
  const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[\p{L}\p{N}]{1,40}USDT$/u.test(symbol)) throw failure('INVALID_SYMBOL', 'Выберите действующую спотовую пару к USDT.');
  return symbol;
}
function browserStorage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
function sleepDefault(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const id = setTimeout(finish, ms);
    const abort = () => { clearTimeout(id); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function symbolInfo(row) {
  if (!row || typeof row.symbol !== 'string' || typeof row.baseAsset !== 'string' || !row.baseAsset || typeof row.quoteAsset !== 'string') throw failure('INVALID_RESPONSE', 'Binance вернул неполное описание пары.');
  return { symbol: row.symbol, baseAsset: row.baseAsset, quoteAsset: row.quoteAsset };
}
const active = row => row?.quoteAsset === 'USDT' && row.status === 'TRADING' && row.isSpotTradingAllowed === true;
function parseFilters(info) {
  if (!Array.isArray(info.filters)) throw failure('INVALID_RESPONSE', 'Не получены ограничения Binance для пары.');
  const byType = new Map(info.filters.map(f => [f.filterType, f]));
  const price = byType.get('PRICE_FILTER'), lot = byType.get('LOT_SIZE');
  if (!price || !lot) throw failure('INVALID_RESPONSE', 'Binance не передал шаг цены или количества.');
  const notional = info.filters.filter(f => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
  const minimums = notional.map(f => number(f.minNotional, 'minNotional', true));
  const maximums = notional.filter(f => f.maxNotional !== undefined).map(f => number(f.maxNotional, 'maxNotional', true)).filter(n => n > 0);
  const percent = byType.get('PERCENT_PRICE'), side = byType.get('PERCENT_PRICE_BY_SIDE');
  const downs = key => [percent?.multiplierDown, side?.[key]].filter(v => v !== undefined).map(v => number(v, key, true)).filter(n => n > 0);
  const ups = key => [percent?.multiplierUp, side?.[key]].filter(v => v !== undefined).map(v => number(v, key, true)).filter(n => n > 0);
  const low = values => values.length ? Math.max(...values) : null;
  const high = values => values.length ? Math.min(...values) : null;
  const windows = [...new Set([percent, side].filter(Boolean).map(f => {
    const n = number(f.avgPriceMins, 'avgPriceMins', true);
    if (!Number.isInteger(n)) throw failure('INVALID_RESPONSE', 'Binance вернул неверное окно средней цены.');
    return n;
  }))];
  const maxQty = number(lot.maxQty, 'maxQty', true);
  return {
    tick: number(price.tickSize, 'tickSize'), step: number(lot.stepSize, 'stepSize'), minQty: number(lot.minQty, 'minQty', true),
    minNotional: minimums.length ? Math.max(...minimums) : null,
    maxQty: maxQty || null, maxNotional: maximums.length ? Math.min(...maximums) : null,
    bidDown: low(downs('bidMultiplierDown')), bidUp: high(ups('bidMultiplierUp')),
    askDown: low(downs('askMultiplierDown')), askUp: high(ups('askMultiplierUp')), windows,
  };
}

/** DI keeps browser code free of Node dependencies. proxyUrl, when provided,
 * must be a same-origin path: /api/binance?path=/api/v3/klines&symbol=...
 * onProgress receives {stage,message,pages?,candles?,cached?}.
 * forceRefresh on loadMarket or loadPriceScale bypasses their shared historical cache.
 */
export function createMarketClient({ fetch: fetcher = globalThis.fetch?.bind(globalThis), storage = browserStorage(), now = Date.now,
  sleep = sleepDefault, proxyUrl = null, timeoutMs = 60000, maxAttempts = 3, maxPages = 20 } = {}) {
  if (typeof fetcher !== 'function') throw new TypeError('Fetch API is required.');
  if (proxyUrl !== null && (typeof proxyUrl !== 'string' || !/^\/(?!\/)[^?#\\]*$/.test(proxyUrl))) throw new TypeError('proxyUrl must be a same-origin относительный путь.');
  if (!(timeoutMs > 0 && timeoutMs <= 60000) || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new TypeError('Invalid request limits.');

  // Only this client's completed results are capabilities for reuse. Public
  // rows and sources remain editable without changing these private copies.
  const liquiditySnapshots = new WeakMap();
  function liquidityPrice(snapshot, symbol, endTime) {
    const verified = liquiditySnapshots.get(snapshot), row = verified?.rows.get(symbol);
    const fresh = time => Number.isSafeInteger(time) && time >= 0 && endTime - time >= 0 && endTime - time < LIQUIDITY_REUSE_AGE;
    if (!row || row.symbol !== symbol || row.quoteAsset !== 'USDT' || row.baseAsset + row.quoteAsset !== symbol || !positive(row.currentPrice) ||
        !fresh(verified.fetchedAt) || !fresh(row.fetchedAt) || !fresh(row.metadataFetchedAt)) return null;
    return row;
  }

  function context(signal) {
    const controller = new AbortController(), started = now();
    const abort = () => controller.abort(failure('ABORTED', 'Загрузка отменена.'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(failure('TIMEOUT', 'Binance не ответил за отведённое время. Повторите обновление.')), timeoutMs);
    return {
      signal: controller.signal, endTime: started,
      check() {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (now() - started >= timeoutMs) throw failure('TIMEOUT', 'Превышено время загрузки Binance.');
      },
      async wait(ms) {
        this.check();
        if (ms >= timeoutMs - (now() - started)) throw failure('TIMEOUT', 'Binance просит подождать дольше времени загрузки. Повторите позже.');
        await sleep(ms, controller.signal); this.check();
      },
      close() { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
      cancel() { controller.abort(failure('ABORTED', 'Загрузка остановлена.')); },
    };
  }
  async function request(path, params, ctx, { dataOnly = false } = {}) {
    if (!PATHS.has(path)) throw failure('INVALID_ENDPOINT', 'Разрешены только публичные рыночные данные Binance.');
    const query = new URLSearchParams(params).toString();
    // The documented data-only host does not support referencePrice.
    const hosts = dataOnly ? [FALLBACK] : proxyUrl || path === '/api/v3/referencePrice' ? [PRIMARY] : [PRIMARY, FALLBACK];
    let lastError;
    for (let hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
      const source = `${hosts[hostIndex]}${path}?${query}`;
      const url = proxyUrl && !dataOnly ? `${proxyUrl}?${new URLSearchParams({ path, ...params })}` : source;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        ctx.check();
        let response;
        try { response = await fetcher(url, { method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctx.signal }); }
        catch (error) {
          ctx.check();
          lastError = failure('NETWORK_ERROR', 'Не удалось связаться с публичным API Binance. Проверьте интернет и доступность Binance.', { cause: error, source });
          if (hostIndex + 1 < hosts.length) break;
          if (attempt + 1 < maxAttempts) { await ctx.wait(500 * 2 ** attempt); continue; }
          throw lastError;
        }
        ctx.check();
        let data;
        try { data = await response.json(); }
        catch { ctx.check(); if (response.ok) throw failure('INVALID_RESPONSE', 'Binance вернул ответ не в формате JSON.', { source }); }
        ctx.check();
        if (response.ok && !(data && !Array.isArray(data) && typeof data.code === 'number' && data.code < 0)) return { data, source };
        lastError = failure('HTTP_ERROR', `Ошибка Binance ${response.status}${data?.code ? ` (${data.code})` : ''}: ${typeof data?.msg === 'string' ? data.msg.slice(0, 180) : 'ответ недоступен'}.`, { status: response.status, apiCode: data?.code, source });
        if (response.status === 429 || response.status >= 500) {
          if (attempt + 1 < maxAttempts) {
            const retryAfter = response.headers?.get('Retry-After');
            const delay = retryAfter !== null && retryAfter !== undefined && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Math.max(0, Date.parse(retryAfter) - now()) : 500 * 2 ** attempt;
            await ctx.wait(delay); continue;
          }
          if (response.status === 429) throw lastError; // Never bypass the IP limit by switching hosts.
          break;
        }
        if ([403, 451].includes(response.status) && hostIndex + 1 < hosts.length) break;
        throw lastError;
      }
    }
    throw lastError;
  }
  const progress = (callback, payload) => { if (typeof callback === 'function') callback(payload); };
  function readCache(symbol, endTime) {
    try {
      const cache = JSON.parse(storage?.getItem(CACHE_PREFIX + symbol) ?? 'null');
      if (!cache || cache.version !== 2 || cache.symbol !== symbol || !Number.isSafeInteger(cache.throughOpen) || cache.throughOpen % DAY !== 0 || cache.throughOpen >= Math.floor(endTime / DAY) * DAY || !Number.isSafeInteger(cache.historyStart) || cache.historyStart < 0 || cache.historyStart > cache.throughOpen || !Number.isInteger(cache.candles) || cache.candles < 1 || !Number.isInteger(cache.gaps) || cache.gaps < 0 || !Number.isFinite(cache.fullScanAt) || cache.fullScanAt > endTime || endTime - cache.fullScanAt > CACHE_AGE || !Array.isArray(cache.last) || cache.last[0] !== cache.throughOpen) return null;
      const first = parseCandle(cache.firstDay, endTime);
      if (!first.trades || first.open < cache.historyStart || first.open > cache.throughOpen) return null;
      // ath in the cache intentionally covers ONLY days after the listing day.
      // An unrefined first day must never enter this closed historical maximum.
      if (cache.ath === 0 ? cache.athTime !== null : !positive(cache.ath) || !Number.isSafeInteger(cache.athTime) || cache.athTime <= first.open || cache.athTime > cache.throughOpen || cache.athTime % DAY !== 0) return null;
      const c = cache.listingCorrection;
      if (c !== null && (!c || !Number.isFinite(c.high) || c.high < 0 || c.high > first.high || c.interval !== '1m' || !Number.isSafeInteger(c.openTime) || c.openTime % MINUTE !== 0 || c.openTime < first.open || c.openTime > first.closeTime || c.closeTime !== c.openTime + MINUTE - 1 || !Array.isArray(c.sources) || c.sources.length !== 2 || !c.sources.every(s => typeof s === 'string' && s.startsWith('https://')))) return null;
      return cache;
    } catch { return null; }
  }
  function parseCandle(row, endTime, duration = DAY) {
    if (!Array.isArray(row) || row.length < 12) throw failure('INVALID_HISTORY', 'Binance вернул неполную свечу.');
    const open = row[0], closeTime = row[6];
    // Historical maintenance can end a daily candle early (e.g. ETH 2018-02-08).
    if (!Number.isSafeInteger(open) || open < 0 || open % duration !== 0 || open > endTime || !Number.isSafeInteger(closeTime) || closeTime < open || closeTime >= open + duration) throw failure('INVALID_HISTORY', 'В истории Binance неверные даты свечей.');
    const prices = [row[1], row[2], row[3], row[4]];
    const volume = Number(row[5]), trades = row[8];
    if (!prices.every(positive) || Number(row[2]) < Math.max(...prices.map(Number)) || Number(row[3]) > Math.min(...prices.map(Number)) || !Number.isFinite(volume) || volume < 0 || !Number.isSafeInteger(trades) || trades < 0 || (trades > 0) !== (volume > 0)) throw failure('INVALID_HISTORY', 'В истории Binance неверные цены, объём или число сделок.');
    return { open, closeTime, high: Number(row[2]), prices: prices.map(Number), volume, trades, raw: row,
      fingerprint: [open, ...prices.map(Number), volume, trades, closeTime] };
  }
  async function listingChildren(symbol, parent, interval, duration, ctx) {
    const result = await request('/api/v3/klines', { symbol, interval, timeZone: '0', startTime: String(parent.open), endTime: String(Math.min(parent.closeTime, ctx.endTime)), limit: '1000' }, ctx);
    if (!Array.isArray(result.data) || !result.data.length || result.data.length > 1000) throw failure('INCOMPLETE_HISTORY', 'Не получена подробная история начала торгов. Максимум не применён.');
    const rows = result.data.map(row => parseCandle(row, ctx.endTime, duration));
    for (let i = 0; i < rows.length; i++) if (rows[i].open < parent.open || rows[i].open > parent.closeTime || rows[i].closeTime > parent.closeTime || (i && rows[i].open <= rows[i - 1].open)) throw failure('INVALID_HISTORY', 'Перепутаны даты подробной истории листинга.');
    // Zero-trade bars may carry the excluded price forward; they are not trades.
    const traded = rows.filter(row => row.trades > 0);
    const trades = traded.reduce((sum, row) => sum + row.trades, 0);
    const volume = traded.reduce((sum, row) => sum + row.volume, 0);
    const prices = traded.length ? [traded[0].prices[0], Math.max(...traded.map(r => r.high)), Math.min(...traded.map(r => r.prices[2])), traded.at(-1).prices[3]] : [];
    if (!traded.length || trades !== parent.trades || prices.some((p, i) => p !== parent.prices[i]) || Math.abs(volume - parent.volume) > Math.max(volume, parent.volume) * 1e-8) throw failure('INCONSISTENT_LISTING', 'Подробная история листинга не совпала с дневной. Повторите обновление; непроверенный максимум не применён.');
    return { rows: traded, source: result.source };
  }
  async function correctListingDay(symbol, first, ctx) {
    const hours = await listingChildren(symbol, first, '1h', HOUR, ctx);
    const minutes = await listingChildren(symbol, hours.rows[0], '1m', MINUTE, ctx);
    const excluded = minutes.rows[0];
    return { high: Math.max(0, ...hours.rows.slice(1).map(r => r.high), ...minutes.rows.slice(1).map(r => r.high)),
      interval: '1m', openTime: excluded.open, closeTime: excluded.open + MINUTE - 1, sources: [hours.source, minutes.source] };
  }
  async function history(symbol, ctx, onProgress, forceRefresh) {
    let cache = forceRefresh ? null : readCache(symbol, ctx.endTime);
    let retriesFromZero = 0;
    for (;;) {
      const today = Math.floor(ctx.endTime / DAY) * DAY;
      let cursor = cache?.throughOpen ?? 0, lastOpen = cache?.throughOpen ?? null;
      let state = cache ? { ...cache } : { version: 2, symbol, ath: 0, athTime: null, firstDay: null, listingCorrection: null, historyStart: null, candles: 0, gaps: 0, fullScanAt: ctx.endTime };
      let closedState = cache ? { ...cache } : null, source = null, reload = false;
      let received = 0;
      for (let page = 1; page <= maxPages; page++) {
        const result = await request('/api/v3/klines', { symbol, interval: '1d', timeZone: '0', startTime: String(cursor), endTime: String(ctx.endTime), limit: '1000' }, ctx);
        source = result.source;
        if (!Array.isArray(result.data) || result.data.length > 1000) throw failure('INVALID_HISTORY', 'Binance вернул неверную страницу истории.');
        const rows = result.data.map(row => parseCandle(row, ctx.endTime));
        for (let i = 0; i < rows.length; i++) if (rows[i].open < cursor || (i > 0 && rows[i].open <= rows[i - 1].open)) throw failure('INVALID_HISTORY', 'История содержит повторяющиеся или перепутанные дневные свечи.');
        if (cache && page === 1) {
          if (rows[0]?.open !== cache.throughOpen || JSON.stringify(rows[0]?.fingerprint) !== JSON.stringify(cache.last)) { reload = true; break; }
          rows.shift(); // Verified overlap was already included in the closed historical aggregate.
        }
        for (const row of rows) {
          if (lastOpen !== null && row.open <= lastOpen) throw failure('INVALID_HISTORY', 'Страницы истории Binance повторяются.');
          if (lastOpen !== null && row.open > lastOpen + DAY) state.gaps += (row.open - lastOpen) / DAY - 1;
          if (state.historyStart === null) state.historyStart = row.open;
          if (row.trades && !state.firstDay) state.firstDay = row.raw;
          else if (row.trades && row.high > state.ath) { state.ath = row.high; state.athTime = row.open; }
          state.candles++; received++; lastOpen = row.open;
          if (row.open < today) closedState = { ...state, throughOpen: row.open, last: row.fingerprint };
        }
        progress(onProgress, { stage: 'history', message: `Загружена история: ${state.candles} дневных свечей.`, pages: page, candles: state.candles, cached: Boolean(cache) });
        if (lastOpen === today && state.candles > 0 && received > 0) {
          const warnings = state.gaps ? [`В доступной истории пары ${state.gaps} пропущенных дней. Максимум рассчитан только по возвращённым Binance свечам; история листингов и миграций не объединяется.`] : [];
          if (!state.firstDay) throw failure('INCOMPLETE_HISTORY', 'В истории пары нет сделок для расчёта максимума.');
          const first = parseCandle(state.firstDay, ctx.endTime);
          // A later high >= the entire listing day proves the exclusion cannot
          // change ATH. Defer refinement, retaining the raw day separately.
          if (first.high > state.ath && !state.listingCorrection) {
            progress(onProgress, { stage: 'history', message: 'Проверяю максимум без первой минутной свечи листинга.' });
            try { state.listingCorrection = await correctListingDay(symbol, first, ctx); }
            catch (error) {
              if (error.code === 'INCONSISTENT_LISTING' && first.open === today && retriesFromZero === 0) { reload = true; break; }
              throw error;
            }
            if (closedState) closedState.listingCorrection = state.listingCorrection;
          }
          const corrected = state.listingCorrection?.high ?? 0;
          const ath = Math.max(state.ath, corrected), athTime = corrected > state.ath ? first.open : state.athTime;
          if (!positive(ath)) throw failure('INCOMPLETE_HISTORY', 'После первой минутной свечи ещё нет сделок для расчёта максимума.');
          const listingExclusion = state.listingCorrection ? { ...state.listingCorrection } : { interval: '1m', notNeeded: true };
          return { ath, athTime, listingExclusion, historyStart: state.historyStart, historyThrough: ctx.endTime, source, warnings, cache: closedState?.firstDay ? closedState : null, candles: state.candles };
        }
        if (result.data.length < 1000 || lastOpen === null) throw failure('INCOMPLETE_HISTORY', 'Дневная история Binance не дошла до текущего UTC-дня. Частичный максимум не применён.');
        const next = lastOpen + DAY;
        if (next <= cursor || next > ctx.endTime) throw failure('INVALID_HISTORY', 'Нарушена последовательность страниц истории Binance.');
        cursor = next;
      }
      if (reload && retriesFromZero++ === 0) { cache = null; progress(onProgress, { stage: 'history', message: 'История изменилась: проверяю максимум заново с начала.' }); continue; }
      throw failure('INCOMPLETE_HISTORY', 'Не удалось полностью проверить историю пары за допустимое число запросов. Максимум не применён.');
    }
  }
  async function reference(symbol, filters, currentPrice, ctx) {
    const sources = {}, warnings = [];
    let absent = false;
    try {
      const response = await request('/api/v3/referencePrice', { symbol }, ctx); sources.referencePrice = response.source;
      if (response.data?.symbol && response.data.symbol !== symbol) throw failure('INVALID_RESPONSE', 'Опорная цена получена для другой пары.');
      if (response.data?.referencePrice === null) absent = true;
      else {
        return { referencePrice: number(response.data?.referencePrice, 'referencePrice'), referenceSource: 'referencePrice', sources, warnings };
      }
    } catch (error) {
      ctx.check();
      if (error.apiCode === -2043) { absent = true; sources.referencePrice = error.source; }
      else return { referencePrice: null, referenceSource: 'unavailable', sources, warnings: [`Опорная цена недоступна; допустимый диапазон заявки не проверен. ${error.message}`] };
    }
    if (absent) {
      if (filters.windows.length > 1) return { referencePrice: null, referenceSource: 'unavailable', sources, warnings: ['Фильтры используют разные окна средней цены; допустимый диапазон заявки не проверен.'] };
      if (filters.windows[0] === 0) return { referencePrice: currentPrice, referenceSource: 'lastPrice', sources, warnings };
      try {
        const response = await request('/api/v3/avgPrice', { symbol }, ctx); sources.avgPrice = response.source;
        const mins = number(response.data?.mins, 'avgPrice.mins', true);
        if (!Number.isInteger(mins) || (filters.windows.length && mins !== filters.windows[0])) throw failure('VWAP_WINDOW_MISMATCH', 'Окно средней цены Binance не совпадает с окном фильтра.');
        return { referencePrice: number(response.data?.price, 'avgPrice'), referenceSource: `avgPrice:${mins}m`, sources, warnings };
      } catch (error) {
        ctx.check();
        return { referencePrice: null, referenceSource: 'unavailable', sources, warnings: [`Опорная цена недоступна; допустимый диапазон заявки не проверен. ${error.message}`] };
      }
    }
  }
  async function loadCatalog({ signal } = {}) {
    const ctx = context(signal);
    try {
      const { data } = await request('/api/v3/exchangeInfo', { permissions: 'SPOT', symbolStatus: 'TRADING', showPermissionSets: 'false' }, ctx);
      if (!Array.isArray(data?.symbols)) throw failure('INVALID_RESPONSE', 'Binance не передал каталог пар.');
      const rows = data.symbols.filter(active).map(symbolInfo);
      if (!rows.length || new Set(rows.map(r => r.symbol)).size !== rows.length) throw failure('INVALID_RESPONSE', 'Каталог спотовых пар Binance пуст или содержит повторы.');
      return rows.sort((a, b) => a.baseAsset.localeCompare(b.baseAsset));
    } finally { ctx.close(); }
  }
  /** Current liquidity, not order-book depth or an execution guarantee.
   * Volume is the rolling 24h quote volume in USDT. Spread is
   * (best ask - best bid) / their midpoint * 100, in percentage points.
   * Missing sides yield null spread. No liquidity thresholds or ATH requests.
   * Binance documents batch symbols for both endpoints; groups of 20 keep
   * ticker/24hr request weight at 2 rather than 40 for 21-100 symbols.
   */
  async function loadLiquidity(inputSymbols, { signal, onProgress } = {}) {
    if (!Array.isArray(inputSymbols) || inputSymbols.length > 1000) throw failure('INVALID_SYMBOLS', 'Передайте список не более 1000 пар к USDT.');
    const symbols = [...new Set(inputSymbols.map(normalizeSymbol))], ctx = context(signal);
    const result = { rows: [], unavailable: [], fetchedAt: null, sources: { exchangeInfo: null, ticker24hr: [], bookTicker: [] }, warnings: [] };
    const verifiedRows = new Map();
    const batchIndex = (data, wanted, endpoint) => {
      if (!Array.isArray(data)) throw failure('INVALID_RESPONSE', `Binance вернул неверный пакет ${endpoint}.`);
      const expected = new Set(wanted), index = new Map();
      for (const row of data) {
        if (!row || !expected.has(row.symbol) || index.has(row.symbol)) throw failure('INVALID_RESPONSE', `В пакете ${endpoint} получена другая пара или повтор.`);
        index.set(row.symbol, row);
      }
      if (index.size !== wanted.length) throw failure('INCOMPLETE_BATCH', `В пакете ${endpoint} отсутствуют запрошенные пары. Повторите обновление.`);
      return index;
    };
    try {
      ctx.check();
      if (symbols.length) {
        progress(onProgress, { stage: 'metadata', message: 'Проверяю доступность пар Binance Spot.' });
        const metadata = await request('/api/v3/exchangeInfo', { permissions: 'SPOT', symbolStatus: 'TRADING', showPermissionSets: 'false' }, ctx, { dataOnly: true });
        const metadataFetchedAt = now();
        result.sources.exchangeInfo = metadata.source;
        if (!Array.isArray(metadata.data?.symbols)) throw failure('INVALID_RESPONSE', 'Binance не передал каталог пар.');
        const catalog = new Map();
        for (const row of metadata.data.symbols) {
          symbolInfo(row);
          if (catalog.has(row.symbol) || typeof row.status !== 'string' || typeof row.isSpotTradingAllowed !== 'boolean') throw failure('INVALID_RESPONSE', 'Каталог Binance содержит повтор или неполный статус пары.');
          catalog.set(row.symbol, row);
        }
        const available = [];
        for (const symbol of symbols) {
          if (active(catalog.get(symbol))) available.push(symbol);
          else result.unavailable.push({ symbol, code: 'UNAVAILABLE_SYMBOL', message: 'Нет активной спотовой пары к USDT на Binance.' });
        }
        for (let offset = 0; offset < available.length; offset += 20) {
          const batch = available.slice(offset, offset + 20), params = { symbols: JSON.stringify(batch), symbolStatus: 'TRADING' };
          const [ticker, books] = await Promise.all([
            request('/api/v3/ticker/24hr', { ...params, type: 'FULL' }, ctx, { dataOnly: true })
              .then(response => ({ ...response, fetchedAt: now() })),
            request('/api/v3/ticker/bookTicker', params, ctx, { dataOnly: true }),
          ]);
          ctx.check();
          const tickers = batchIndex(ticker.data, batch, 'ticker/24hr'), bookRows = batchIndex(books.data, batch, 'bookTicker');
          result.sources.ticker24hr.push(ticker.source); result.sources.bookTicker.push(books.source);
          const fetchedAt = ticker.fetchedAt; // Waiting for the book must not make an older quote appear newer.
          for (const symbol of batch) {
            const t = tickers.get(symbol), b = bookRows.get(symbol), warnings = [];
            const lastPrice = number(t.lastPrice, 'ticker24hr.lastPrice', true), quoteVolume24h = number(t.quoteVolume, 'ticker24hr.quoteVolume', true);
            const bidPrice = number(b.bidPrice, 'bookTicker.bidPrice', true), askPrice = number(b.askPrice, 'bookTicker.askPrice', true);
            const bidQty = number(b.bidQty, 'bookTicker.bidQty', true), askQty = number(b.askQty, 'bookTicker.askQty', true);
            if (!Number.isSafeInteger(t.openTime) || t.openTime < 0 || !Number.isSafeInteger(t.closeTime) || t.closeTime < t.openTime) throw failure('INVALID_RESPONSE', 'Binance вернул неверный период статистики 24ч.');
            if (bidPrice > 0 && askPrice > 0 && bidPrice > askPrice) throw failure('INVALID_RESPONSE', 'Binance вернул цену покупки выше цены продажи в стакане.');
            const bookAvailable = bidPrice > 0 && askPrice > 0 && bidQty > 0 && askQty > 0;
            const spreadPercent = bookAvailable ? (askPrice - bidPrice) / (askPrice / 2 + bidPrice / 2) * 100 : null;
            if (!bookAvailable) warnings.push('Одна из сторон стакана пуста; спред неизвестен.');
            if (!lastPrice) warnings.push('Последняя цена сделки пока недоступна.');
            result.rows.push({ ...symbolInfo(catalog.get(symbol)), currentPrice: lastPrice || null, quoteVolume24h, bidPrice, askPrice, bidQty, askQty,
              spreadPercent, bookAvailable, openTime: t.openTime, closeTime: t.closeTime, fetchedAt, warnings });
            verifiedRows.set(symbol, Object.freeze({ ...symbolInfo(catalog.get(symbol)), currentPrice: lastPrice || null, fetchedAt, metadataFetchedAt,
              exchangeInfo: metadata.source, ticker: ticker.source }));
            result.warnings.push(...warnings.map(message => `${symbol}: ${message}`));
          }
          progress(onProgress, { stage: 'liquidity', message: `Ликвидность: ${result.rows.length} из ${available.length} пар.`, completed: result.rows.length, total: available.length });
        }
      }
      ctx.check(); result.fetchedAt = now();
      progress(onProgress, { stage: 'done', message: `Проверено ${result.rows.length} активных пар Binance Spot.` });
      ctx.check();
      liquiditySnapshots.set(result, Object.freeze({ rows: verifiedRows, fetchedAt: result.fetchedAt }));
      return result;
    } catch (error) { ctx.cancel(); throw error; }
    finally { ctx.close(); }
  }
  /** A verified price/ATH snapshot for overview scales. Order constraints are
   * intentionally absent: a missing order reference must not hide market data.
   * The history validator and closed-candle cache are shared with loadMarket.
   * liquiditySnapshot may reuse a completed loadLiquidity result from this
   * client for under one minute; history is still fetched and fully validated.
   */
  async function loadPriceScale(inputSymbol, { signal, onProgress, forceRefresh = false, liquiditySnapshot } = {}) {
    const symbol = normalizeSymbol(inputSymbol), ctx = context(signal);
    try {
      progress(onProgress, { stage: 'metadata', message: `Проверяю спотовую пару ${symbol}.` });
      const reused = !forceRefresh && liquidityPrice(liquiditySnapshot, symbol, ctx.endTime);
      let price = reused;
      if (!price) {
        const metadata = await request('/api/v3/exchangeInfo', { symbol }, ctx);
        if (!Array.isArray(metadata.data?.symbols) || metadata.data.symbols.length !== 1 || metadata.data.symbols[0]?.symbol !== symbol || !active(metadata.data.symbols[0])) throw failure('UNAVAILABLE_SYMBOL', 'Эта пара сейчас недоступна для спотовой торговли к USDT на Binance.');
        const info = symbolInfo(metadata.data.symbols[0]);
        const ticker = await request('/api/v3/ticker/price', { symbol }, ctx);
        if (ticker.data?.symbol !== symbol) throw failure('INVALID_RESPONSE', 'Текущая цена получена для другой пары.');
        price = { ...info, currentPrice: number(ticker.data?.price, 'ticker.price'), exchangeInfo: metadata.source, ticker: ticker.source };
      }
      const daily = await history(symbol, ctx, onProgress, forceRefresh);
      ctx.check();
      const warnings = [...daily.warnings];
      if (daily.cache) {
        try { storage?.setItem(CACHE_PREFIX + symbol, JSON.stringify(daily.cache)); }
        catch { warnings.push('Исторический кэш не сохранён; при следующем обновлении история будет загружена заново.'); }
      }
      const result = { ...symbolInfo(price), currentPrice: price.currentPrice, ath: daily.ath, athTime: daily.athTime, historyStart: daily.historyStart,
        historyThrough: daily.historyThrough, fetchedAt: reused ? price.fetchedAt : now(), source: daily.source, scope: ATH_SCOPE, athScope: ATH_SCOPE, listingExclusion: daily.listingExclusion, warnings,
        sources: { exchangeInfo: price.exchangeInfo, ticker: price.ticker, klines: daily.source } };
      progress(onProgress, { stage: 'done', message: `${symbol}: цена и максимум доступной истории обновлены.` });
      return result;
    } catch (error) { ctx.cancel(); throw error; }
    finally { ctx.close(); }
  }
  async function loadMarket(inputSymbol, { signal, onProgress, forceRefresh = false } = {}) {
    const symbol = normalizeSymbol(inputSymbol), ctx = context(signal);
    try {
      progress(onProgress, { stage: 'metadata', message: `Проверяю ${symbol} и ограничения Binance.` });
      const metadata = await request('/api/v3/exchangeInfo', { symbol }, ctx);
      if (!Array.isArray(metadata.data?.symbols) || metadata.data.symbols.length !== 1 || metadata.data.symbols[0]?.symbol !== symbol || !active(metadata.data.symbols[0])) throw failure('UNAVAILABLE_SYMBOL', 'Эта пара сейчас недоступна для спотовой торговли к USDT на Binance.');
      const info = symbolInfo(metadata.data.symbols[0]), filters = parseFilters(metadata.data.symbols[0]);
      const ticker = await request('/api/v3/ticker/price', { symbol }, ctx);
      if (ticker.data?.symbol !== symbol) throw failure('INVALID_RESPONSE', 'Текущая цена получена для другой пары.');
      const currentPrice = number(ticker.data?.price, 'ticker.price');
      const [daily, ref] = await Promise.all([history(symbol, ctx, onProgress, forceRefresh), reference(symbol, filters, currentPrice, ctx)]);
      ctx.check();
      const warnings = [...daily.warnings, ...ref.warnings];
      if (daily.cache) {
        try { storage?.setItem(CACHE_PREFIX + symbol, JSON.stringify(daily.cache)); }
        catch { warnings.push('Исторический кэш не сохранён; при следующем обновлении история будет загружена заново.'); }
      }
      const { windows, ...publicFilters } = filters;
      const result = { ...info, currentPrice, ath: daily.ath, athTime: daily.athTime, historyStart: daily.historyStart,
        historyThrough: daily.historyThrough, fetchedAt: now(), ...publicFilters, referencePrice: ref.referencePrice,
        referenceSource: ref.referenceSource, source: daily.source, athScope: ATH_SCOPE, listingExclusion: daily.listingExclusion, warnings,
        sources: { exchangeInfo: metadata.source, ticker: ticker.source, klines: daily.source, ...ref.sources } };
      progress(onProgress, { stage: 'done', message: `${symbol}: цена и максимум доступной истории обновлены.` });
      return result;
    } catch (error) { ctx.cancel(); throw error; }
    finally { ctx.close(); }
  }
  return { loadCatalog, loadMarket, loadPriceScale, loadLiquidity };
}
let defaultClient;
const client = () => (defaultClient ??= createMarketClient());
export const loadCatalog = options => client().loadCatalog(options);
export const loadMarket = (symbol, options) => client().loadMarket(symbol, options);
export const loadPriceScale = (symbol, options) => client().loadPriceScale(symbol, options);
export const loadLiquidity = (symbols, options) => client().loadLiquidity(symbols, options);
