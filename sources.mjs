import {createMarketClient} from './market.mjs';
import {parseMonitoring,MONITORING_API} from './monitoring.mjs';
import {mergePart,validateSnapshot} from './quality-model.mjs';
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const nullable=v=>v===null||v===undefined?null:finite(v)?v:null;
const iso=v=>new Date(v).toISOString();
const BINANCE_SOURCE='https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints';
export function parseRepository(data,repo,now=Date.now()){
  if(data?.full_name?.toLowerCase()!==repo.toLowerCase()||typeof data.archived!=='boolean'||!Number.isFinite(Date.parse(data.pushed_at))||Date.parse(data.pushed_at)>now+300000)throw new Error('Репозиторий или дата не подтверждены');
  return {repo,archived:data.archived,pushedAt:data.pushed_at};
}
export function parseSupply(data,id,now=Date.now()){
  if(data?.id!==id||!Number.isFinite(Date.parse(data.last_updated))||Date.parse(data.last_updated)>now+300000)throw new Error('ID актива или дата CoinGecko не подтверждены');
  const circulating=nullable(data.circulating_supply),total=nullable(data.total_supply),max=nullable(data.max_supply);
  if(circulating!=null&&(total!=null&&circulating>total||max!=null&&circulating>max)||total!=null&&max!=null&&total>max)throw new Error('Противоречивое предложение');
  return {circulating,total,max,marketCap:nullable(data.market_cap),fdv:nullable(data.fully_diluted_valuation)};
}
export function parseBinanceObservation(row,review,monitoring=null){
  if(row&&(row.symbol!==review.symbol||row.baseAsset!==review.coin||row.quoteAsset!=='USDT'))throw new Error('Базовый актив Binance не совпал с разбором');
  const spread=row?.spreadPercent==null?null:row.spreadPercent/100;
  return {active:!!row,quoteVolume24h:row?.quoteVolume24h??null,spread,liquid:row&&spread!==null?row.quoteVolume24h>=1000000&&spread<=.003:null,monitoring};
}
export function createCollector({fetch=globalThis.fetch,now=Date.now,githubToken='',coingeckoKey='',mappings={}}={}){
  async function json(url,headers={}){
    const response=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  const failed=()=>({status:'error',attemptedAt:iso(now()),note:'Источник не ответил или данные не прошли проверку.'});
  const absent=note=>({status:'not-configured',note});
  async function repository(review){
    const mapping=mappings[review.coin]?.github??review.github;
    if(!mapping)return absent('Основной официальный репозиторий не сопоставлен.');
    const source=`https://github.com/${mapping.repo}`;
    try{const data=await json(`https://api.github.com/repos/${mapping.repo}`,{'Accept':'application/vnd.github+json','User-Agent':'SpotGridResearch',...(githubToken?{Authorization:`Bearer ${githubToken}`}:{})});
      return {status:'ok',fetchedAt:iso(now()),sourceAt:null,source,data:parseRepository(data,mapping.repo,now()),note:mapping.note??''};
    }catch{return {...failed(),source};}
  }
  async function defi(review,chains){
    const mapping=mappings[review.coin]?.defillama??review.defillama;
    if(!mapping)return absent('Сеть или протокол не сопоставлены; TVL не универсален.');
    const {kind,slug,source,feesSlug}=mapping;
    try{
      let tvl=null,fees24h=null,revenue24h=null;
      if(kind==='chain'){
        if(!Array.isArray(chains))throw new Error('Нет списка сетей');
        const matches=chains.filter(x=>x.name===slug);if(matches.length!==1||!finite(matches[0].tvl))throw new Error('Сеть не подтверждена');tvl=matches[0].tvl;
      }else if(kind==='protocol'){
        const value=await json(`https://api.llama.fi/tvl/${encodeURIComponent(slug)}`);if(!finite(value))throw new Error('TVL не подтверждён');tvl=value;
      }else throw new Error('Неверный тип');
      let note=mapping.note??'';
      if(feesSlug){try{const fees=await json(`https://api.llama.fi/summary/fees/${encodeURIComponent(feesSlug)}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees`);fees24h=nullable(fees.total24h);note+=' Выручка держателей не рассчитывается.';}catch{note+=' Комиссии не удалось получить; TVL обновлён.';}}
      return {status:'ok',fetchedAt:iso(now()),sourceAt:null,source,data:{kind,slug,tvl,fees24h,revenue24h},note};
    }catch{return {...failed(),source};}
  }
  async function binance(reviews){
    const result={};let tags=null;
    try{tags=parseMonitoring(await json(MONITORING_API),now()).bySymbol;}catch{}
    try{
      const market=createMarketClient({fetch,storage:null,now});
      const batch=await market.loadLiquidity(reviews.map(r=>r.symbol));const rows=new Map(batch.rows.map(r=>[r.symbol,r]));
      for(const review of reviews){const r=rows.get(review.symbol);
        try{result[review.symbol]={status:'ok',fetchedAt:iso(r?.fetchedAt??batch.fetchedAt),sourceAt:r?iso(r.closeTime):null,source:BINANCE_SOURCE,data:parseBinanceObservation(r,review,tags?.get(review.symbol)??null),note:tags?'':'Monitoring не удалось подтвердить.'};}catch{result[review.symbol]={...failed(),source:BINANCE_SOURCE};}
      }
    }catch{for(const review of reviews)result[review.symbol]={...failed(),source:BINANCE_SOURCE};}
    return result;
  }
  async function supplies(reviews){
    const result={};const ids=[...new Set(reviews.map(r=>mappings[r.coin]?.coingeckoId??r.coingeckoId).filter(Boolean))];
    let rows=null;
    if(coingeckoKey&&ids.length){try{const values=await json(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(','))}&per_page=250`,{'x-cg-demo-api-key':coingeckoKey});if(!Array.isArray(values))throw new Error('Неверный пакет');rows=new Map();for(const r of values){if(!ids.includes(r.id)||rows.has(r.id))throw new Error('ID не совпал');rows.set(r.id,r);}}catch{rows=null;}}
    for(const r of reviews){const id=mappings[r.coin]?.coingeckoId??r.coingeckoId;
      if(!id||!coingeckoKey){result[r.symbol]=absent(!id?'Идентификатор поставщика не подтверждён.':'Бесплатный источник предложения пока не подключён.');continue;}
      const source=`https://www.coingecko.com/en/coins/${id}`;
      try{const row=rows?.get(id);result[r.symbol]={status:'ok',fetchedAt:iso(now()),sourceAt:row?.last_updated,source,data:parseSupply(row,id,now())};}catch{result[r.symbol]={...failed(),source};}
    }
    return result;
  }
  async function collect(reviews,{previous=null,includeMarket=true}={}){
    const snapshot={schemaVersion:1,generatedAt:iso(now()),coins:{...(previous?.coins??{})}};
    const market=includeMarket?await binance(reviews):null,supply=includeMarket?await supplies(reviews):null;
    let chains=null;if(reviews.some(r=>(mappings[r.coin]?.defillama??r.defillama)?.kind==='chain')){try{chains=await json('https://api.llama.fi/v2/chains');}catch{}}
    for(const review of reviews){
      const old=snapshot.coins[review.symbol]??{};
      const next={github:await repository(review),defillama:await defi(review,chains),...(market?{binance:market[review.symbol],supply:supply[review.symbol]}:{})};
      snapshot.coins[review.symbol]={...old,...Object.fromEntries(Object.entries(next).map(([k,v])=>[k,mergePart(old[k],v)]))};
    }
    snapshot.generatedAt=iso(now());
    return validateSnapshot(snapshot,Object.keys(snapshot.coins),now());
  }
  return {collect,binance,supplies};
}
