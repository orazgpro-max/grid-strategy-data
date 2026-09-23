// Standalone entry point for the public data repository. No private account data.
import fs from 'node:fs/promises';
import {createCollector} from './sources.mjs';
import {validateReviews,validateSnapshot} from './quality-model.mjs';
const input=JSON.parse(await fs.readFile('research.json','utf8'));
const reviews=validateReviews(input.reviews,input.candidates);
if(reviews.length!==input.candidates.length)throw new Error('Research coverage is incomplete');
const previous=await fs.readFile('daily.json','utf8').then(JSON.parse).then(s=>validateSnapshot(s,reviews.map(r=>r.symbol))).catch(()=>null);
const collector=createCollector({githubToken:process.env.GITHUB_TOKEN??'',coingeckoKey:process.env.COINGECKO_DEMO_API_KEY??'',mappings:input.mappings});
const result=await collector.collect(reviews,{previous});
await fs.writeFile('daily.json',JSON.stringify(result,null,2)+'\n');
const failures=[];for(const [symbol,parts]of Object.entries(result.coins))for(const [part,data]of Object.entries(parts))if(data.status==='error')failures.push(`${symbol}:${part}`);
console.log(JSON.stringify({generatedAt:result.generatedAt,coins:reviews.length,unavailable:failures}));
// Preserve a partial snapshot but expose operational failure in the job summary.
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`Updated: ${result.generatedAt}. Coins: ${reviews.length}. Failed source checks: ${failures.length}.\n`);
