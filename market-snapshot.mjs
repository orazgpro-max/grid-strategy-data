/** Shared public Binance history. Live trading availability, prices and spreads
 * remain separate. No private account data or API keys enter this snapshot. */
import {validateHistoryCache} from './market.mjs';

export const MARKET_SNAPSHOT_URL = 'https://raw.githubusercontent.com/orazgpro-max/grid-strategy-data/main/market-snapshot.json';
export const MARKET_SNAPSHOT_MAX_AGE = 36 * 3600000;
const DAY = 86400000;
const REUSE_AGE = 5 * 60000;
const validSymbol = value => typeof value === 'string' && /^[\p{L}\p{N}]{1,40}USDT$/u.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const day = value => Number.isSafeInteger(value) && value >= 0 && value % DAY === 0;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = () => { throw new Error('Неверный формат общего снимка Binance.'); };

/** Stale but structurally valid data is retained with its original dates. Cache
 * validation uses the observation date; consumers recheck its 30-day lifetime
 * against the actual current time before seeding the daily history cache. */
export function validateMarketSnapshot(raw, {now = Date.now()} = {}) {
  if (!object(raw) || raw.version !== 1 || !timestamp(raw.generatedAt) || Date.parse(raw.generatedAt) > now + 300000 ||
      !day(raw.throughOpen) || raw.throughOpen >= Math.floor(Date.parse(raw.generatedAt) / DAY) * DAY ||
      !object(raw.coins) || !Object.keys(raw.coins).length || Object.keys(raw.coins).length > 2000) bad();
  const coins = Object.create(null), generatedAt = Date.parse(raw.generatedAt);
  for (const [symbol, row] of Object.entries(raw.coins)) {
    if (!validSymbol(symbol) || !object(row) || !['ok', 'error'].includes(row.status) ||
        !timestamp(row.attemptedAt) || Date.parse(row.attemptedAt) > generatedAt ||
        row.fetchedAt !== null && (!timestamp(row.fetchedAt) || Date.parse(row.fetchedAt) > Date.parse(row.attemptedAt)) ||
        row.status === 'ok' && row.fetchedAt === null || !Array.isArray(row.dailyVolumes) || row.dailyVolumes.length > 30) bad();
    let previous = -1;
    const dailyVolumes = row.dailyVolumes.map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2 || !day(pair[0]) || pair[0] <= previous || pair[0] > raw.throughOpen ||
          row.fetchedAt === null || pair[0] >= Math.floor(Date.parse(row.fetchedAt) / DAY) * DAY || !finite(pair[1])) bad();
      previous = pair[0]; return [...pair];
    });
    let historyCache = null;
    if (row.historyCache !== null) {
      if (!row.fetchedAt) bad();
      historyCache = validateHistoryCache(row.historyCache, symbol, Date.parse(row.fetchedAt));
      if (!historyCache || historyCache.throughOpen > raw.throughOpen) bad();
      historyCache = JSON.parse(JSON.stringify(historyCache));
    }
    if (row.fetchedAt === null && (dailyVolumes.length || historyCache)) bad();
    if (row.error !== undefined && (typeof row.error !== 'string' || !/^[A-Z_0-9]{1,80}$/.test(row.error))) bad();
    coins[symbol] = {status: row.status, fetchedAt: row.fetchedAt, attemptedAt: row.attemptedAt, dailyVolumes, historyCache,
      ...(row.status === 'error' ? {error: row.error ?? 'SOURCE_UNAVAILABLE'} : {})};
  }
  return {version: 1, generatedAt: raw.generatedAt, throughOpen: raw.throughOpen, coins};
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2;
};

/** Unknown, sparse and failed observations never pass a liquidity filter. Days
 * are UTC daily quote volumes; a rolling 24h ticker is not a substitute. */
export function liquidityHistory(snapshot, symbol, {now = Date.now(), minQuoteVolume = 1e6} = {}) {
  const row = snapshot?.coins?.[symbol], throughOpen = snapshot?.throughOpen ?? null;
  const empty = {status: 'unavailable', days: row?.dailyVolumes?.length ?? 0, median30: null, median7: null, daysBelow: null,
    passes: false, throughOpen, fetchedAt: row?.fetchedAt ?? null};
  if (!finite(minQuoteVolume) || !row || row.status !== 'ok' || !timestamp(row.fetchedAt) || !timestamp(snapshot.generatedAt) || !day(throughOpen)) return empty;
  const age = now - Date.parse(row.fetchedAt), snapshotAge = now - Date.parse(snapshot.generatedAt), today = Math.floor(now / DAY) * DAY;
  if (age < -300000 || snapshotAge < -300000 || age > MARKET_SNAPSHOT_MAX_AGE || snapshotAge > MARKET_SNAPSHOT_MAX_AGE || throughOpen < today - 2 * DAY || throughOpen >= today) return {...empty, status: 'stale'};
  const rows = row.dailyVolumes;
  if (!Array.isArray(rows) || rows.length !== 30 || rows.some((pair, i) => !Array.isArray(pair) || pair.length !== 2 || pair[0] !== throughOpen - (29 - i) * DAY || !finite(pair[1]))) return {...empty, status: 'insufficient'};
  const values = rows.map(pair => pair[1]), median30 = median(values), median7 = median(values.slice(-7));
  return {...empty, status: 'ready', median30, median7, daysBelow: values.filter(value => value < minQuoteVolume).length,
    passes: median30 >= minQuoteVolume && median7 >= minQuoteVolume};
}

function followSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once: true});
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** One shared download, independent cancellation for each caller. A failing
 * caller cannot abort another caller's request. Never invents a fresh date. */
export function createMarketSnapshotLoader({fetch = globalThis.fetch?.bind(globalThis), now = Date.now,
  remoteUrl = MARKET_SNAPSHOT_URL, bundledUrl = './research/market-snapshot.json', timeoutMs = 15000} = {}) {
  let memory = null, checkedAt = null, pending = null;
  async function read(url, source) {
    const response = await fetch(url, {method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeoutMs)});
    if (!response.ok) throw new Error('Общий снимок Binance не загружен.');
    const raw = await response.text();
    if (raw.length > 8 * 1024 * 1024) throw new Error('Общий снимок Binance слишком большой.');
    return {...validateMarketSnapshot(JSON.parse(raw), {now: now()}), source, fallback: source !== 'remote',
      warnings: source === 'remote' ? [] : ['Свежий облачный снимок недоступен; показана сохранённая копия с исходной датой.']};
  }
  async function download() {
    let next;
    try {
      next = await read(remoteUrl, 'remote');
      const stale = now() - Date.parse(next.generatedAt) > MARKET_SNAPSHOT_MAX_AGE || next.throughOpen < Math.floor(now() / DAY) * DAY - 2 * DAY;
      if (stale) {
        try {
          const bundled = await read(bundledUrl, 'bundled');
          if (Date.parse(bundled.generatedAt) > Date.parse(next.generatedAt)) next = bundled;
        } catch { /* Keep the older, explicitly dated remote observations. */ }
      }
    }
    catch {
      try { next = await read(bundledUrl, 'bundled'); }
      catch { if (!memory) throw new Error('Общий снимок Binance недоступен.'); }
    }
    if (memory && (!next || Date.parse(memory.generatedAt) > Date.parse(next.generatedAt))) {
      next = {...memory, source: 'memory', fallback: true, warnings: ['Новый снимок недоступен; показан предыдущий снимок с исходной датой.']};
    }
    memory = next; checkedAt = now(); return memory;
  }
  return function load({force = false, signal} = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (!force && memory && checkedAt !== null && now() >= checkedAt && now() - checkedAt < REUSE_AGE) return followSignal(Promise.resolve(memory), signal);
    pending ??= download().finally(() => { pending = null; });
    return followSignal(pending, signal);
  };
}

let defaultLoader;
export function loadMarketSnapshot(options) { return (defaultLoader ??= createMarketSnapshotLoader())(options); }
