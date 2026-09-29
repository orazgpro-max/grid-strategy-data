// Standalone entry point for grid-strategy-data. Only public Binance GET data.
import fs from 'node:fs/promises';
import {collectMarketSnapshot} from './market-collector.mjs';
import {validateMarketSnapshot} from './market-snapshot.mjs';

const target = 'market-snapshot.json';
const previous = await fs.readFile(target, 'utf8').then(JSON.parse).then(value => validateMarketSnapshot(value)).catch(() => null);
const result = await collectMarketSnapshot({previous, onProgress: progress => {
  if (progress.completed % 25 === 0 || progress.completed === progress.total) console.log(`Market history: ${progress.completed}/${progress.total}`);
}});
await fs.writeFile(`${target}.tmp`, JSON.stringify(result) + '\n');
await fs.rename(`${target}.tmp`, target);
const failed = Object.values(result.coins).filter(row => row.status === 'error').length;
const summary = {generatedAt: result.generatedAt, coins: Object.keys(result.coins).length, failed};
console.log(JSON.stringify(summary));
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
  `Market history: ${result.generatedAt}. Active pairs: ${summary.coins}. Failed pairs: ${failed}. Original observation dates are preserved on failures.\n`);
