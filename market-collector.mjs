/** Daily public-only collector, also used by the standalone GitHub job. */
import {createMarketClient, validateHistoryCache, HISTORY_CACHE_PREFIX} from './market.mjs';
import {validateMarketSnapshot} from './market-snapshot.mjs';

const DAY = 86400000;
const PREFIX = HISTORY_CACHE_PREFIX;
const iso = value => new Date(value).toISOString();
const error = (code, message) => Object.assign(new Error(message), {code});

function parseVolumes(rows, today) {
  if (!Array.isArray(rows) || rows.length > 31) throw error('INVALID_VOLUMES', 'Invalid daily volume response');
  let previous = -1;
  const result = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 12 || !Number.isSafeInteger(row[0]) || row[0] % DAY !== 0 || row[0] < today - 30 * DAY || row[0] > today || row[0] <= previous ||
        !Number.isSafeInteger(row[6]) || row[6] < row[0] || row[6] >= row[0] + DAY ||
        !['string', 'number'].includes(typeof row[7]) || String(row[7]).trim() === '' || !Number.isFinite(Number(row[7])) || Number(row[7]) < 0 ||
        !Number.isSafeInteger(row[8]) || row[8] < 0 || (row[8] > 0) !== (Number(row[7]) > 0)) throw error('INVALID_VOLUMES', 'Invalid daily volume candle');
    previous = row[0];
    if (row[0] < today) result.push([row[0], Number(row[7])]);
  }
  return result;
}

export async function collectMarketSnapshot({previous = null, fetch = globalThis.fetch, now = Date.now, onProgress = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxAttempts = 2, workers = 2, signal} = {}) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 2 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new TypeError('Invalid collector limits');
  const started = now(), today = Math.floor(started / DAY) * DAY;
  const old = previous ? validateMarketSnapshot(previous, {now: started}) : null;
  const values = new Map();
  for (const [symbol, row] of Object.entries(old?.coins ?? {})) if (row.historyCache) values.set(PREFIX + symbol, JSON.stringify(row.historyCache));
  const storage = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
  const client = createMarketClient({fetch, now, storage, sleep, maxAttempts, timeoutMs: 60000});
  // The live catalog controls membership; the former review list is not used.
  const live = await client.loadLiquidity(undefined, {signal});
  const symbols = live.rows.map(row => row.symbol).sort();
  const coins = Object.create(null);
  let cursor = 0, completed = 0, halt = null;
  const check = () => { if (signal?.aborted) throw signal.reason ?? error('ABORTED', 'Collector cancelled'); };
  async function dailyVolumes(symbol) {
    const url = new URL('https://data-api.binance.vision/api/v3/klines');
    url.search = new URLSearchParams({symbol, interval: '1d', timeZone: '0', startTime: String(today - 30 * DAY), endTime: String(started), limit: '31'});
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      check();
      try {
        const timeout = AbortSignal.timeout(20000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetch(url.href, {method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: requestSignal});
        // Stop this run on rate limiting instead of multiplying retries across
        // hundreds of symbols or changing hosts to evade the limit.
        if ([418, 429].includes(response.status)) throw error('RATE_LIMITED', 'Binance rate limit');
        if (!response.ok) throw error('HTTP_ERROR', `Daily volume HTTP ${response.status}`);
        return parseVolumes(await response.json(), today);
      } catch (reason) {
        check();
        if (reason.code === 'RATE_LIMITED' || reason.code === 'INVALID_VOLUMES' || attempt + 1 === maxAttempts) throw reason;
        await sleep(500 * 2 ** attempt, signal);
      }
    }
  }
  async function worker() {
    for (;;) {
      check(); const index = cursor++;
      if (index >= symbols.length) return;
      const symbol = symbols[index], prior = old?.coins[symbol];
      try {
        if (halt) throw halt;
        await client.loadPriceScale(symbol, {signal, liquiditySnapshot: live});
        const daily = await dailyVolumes(symbol);
        const fetchedAt = iso(now());
        // A cache can cross its 30-day rescan deadline during the final request.
        // Keep the fresh volume observation, never extend the old scan date.
        const historyCache = validateHistoryCache(JSON.parse(storage.getItem(PREFIX + symbol) ?? 'null'), symbol, Date.parse(fetchedAt));
        coins[symbol] = {status: 'ok', fetchedAt, attemptedAt: fetchedAt, dailyVolumes: daily, historyCache};
      } catch (reason) {
        check();
        if (reason.code === 'RATE_LIMITED' || [418, 429].includes(reason.status)) halt = error('RATE_LIMITED', 'Binance rate limit');
        coins[symbol] = {status: 'error', fetchedAt: prior?.fetchedAt ?? null, attemptedAt: iso(now()), dailyVolumes: prior?.dailyVolumes ?? [],
          historyCache: prior?.historyCache ?? null, error: halt ? 'RATE_LIMITED' : /^[A-Z_0-9]{1,80}$/.test(reason.code ?? '') ? reason.code : 'SOURCE_UNAVAILABLE'};
      }
      onProgress({completed: ++completed, total: symbols.length, symbol, status: coins[symbol].status});
    }
  }
  await Promise.all(Array.from({length: workers}, worker));
  // A run can straddle midnight. Preserve valid ATH caches from both sides;
  // volume windows ending earlier than this date stay visible as insufficient.
  const finished = now(), throughOpen = Math.floor(finished / DAY) * DAY - DAY;
  return validateMarketSnapshot({version: 1, generatedAt: iso(finished), throughOpen, coins}, {now: finished});
}
