/** Research and daily observations are independent. Missing evidence is never a safe verdict. */
export const DAY=86400000;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function safeLink(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}}
export function freshness(value,now=Date.now(),maxAge=DAY){
  if(value==null)return 'missing';
  const time=typeof value==='string'?Date.parse(value):NaN;
  if(!Number.isFinite(time)||time>now+300000)return 'invalid';
  return now-time>maxAge?'stale':'fresh';
}
export function supplyRatios({circulating,total,max}={}){
  const ratio=den=>number(circulating)&&number(den)&&den>0&&circulating<=den?circulating/den:null;
  return {ofTotal:ratio(total),ofMax:ratio(max)};
}
export function mergePart(previous,next){
  if(previous?.source&&next.source&&previous.source!==next.source)return next;
  if(next.status==='error'&&previous?.data)return {...previous,...next,source:previous.source??next.source,data:previous.data,fetchedAt:previous.fetchedAt,sourceAt:previous.sourceAt??null};
  return next;
}
export function observationFreshness(part,now=Date.now()){
  const fetched=freshness(part?.fetchedAt,now);
  if(fetched!=='fresh')return fetched;
  return part.sourceAt?freshness(part.sourceAt,now):'fresh';
}
function assert(value,message){if(!value)throw new Error(message);}
function checkSources(sources){assert(Array.isArray(sources)&&sources.every(u=>!!safeLink(u)),'Некорректные источники разбора.');}
export function validateReviews(rows,candidates,now=Date.now()){
  assert(Array.isArray(rows),'Не получен список разборов.');
  const expected=new Map(candidates.map(x=>[x.symbol,x.coin])),seen=new Set();
  for(const r of rows){
    assert(r&&expected.get(r.symbol)===r.coin&&!seen.has(r.symbol),'Монета разбора не совпала с каталогом либо повторяется.');seen.add(r.symbol);
    assert(['initial','limited'].includes(r.coverage)&&!['invalid','missing'].includes(freshness(r.reviewedAt,now)),'Дата или полнота разбора не подтверждена.');
    assert(typeof r.summary==='string'&&r.summary.length>0,'Нет вывода разбора.');
    for(const key of ['demand','supply','development']){assert(typeof r[key]?.text==='string','Не заполнен раздел разбора.');checkSources(r[key].sources);}
    assert(Array.isArray(r.risks),'Не получены предупреждения.');
    for(const risk of r.risks){assert(typeof risk.text==='string'&&['high','attention'].includes(risk.severity),'Неверное предупреждение.');checkSources(risk.sources);}
    assert(['unverified','documented','not-applicable'].includes(r.unlocks?.status),'Не указан статус календаря.');checkSources(r.unlocks.sources);
    assert(Array.isArray(r.sources)&&r.sources.length>0&&r.sources.every(s=>typeof s.title==='string'&&safeLink(s.url)),'Нет проверяемых источников.');
    if(r.github)assert(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(r.github.repo)&&safeLink(r.github.source),'Репозиторий не подтверждён.');
    if(r.coingeckoId)assert(/^[a-z0-9][a-z0-9-]*$/.test(r.coingeckoId),'Неверный ID поставщика.');
  }
  return rows;
}
export const PARTS=['binance','github','defillama','supply'];
export function validateSnapshot(snapshot,symbols,now=Date.now()){
  assert(snapshot?.schemaVersion===1&&!['missing','invalid'].includes(freshness(snapshot.generatedAt,now))&&snapshot.coins&&typeof snapshot.coins==='object'&&!Array.isArray(snapshot.coins),'Формат снимка не подтверждён.');
  const allowed=new Set(symbols);
  for(const [symbol,parts]of Object.entries(snapshot.coins)){
    assert(allowed.has(symbol)&&parts&&typeof parts==='object','Монета снимка не совпала с каталогом.');
    for(const [key,part]of Object.entries(parts)){
      assert(PARTS.includes(key)&&['ok','error','unavailable','not-configured','not-applicable'].includes(part?.status),'Неверный раздел снимка.');
      if(part.status==='ok'||part.data){assert(!['missing','invalid'].includes(freshness(part.fetchedAt,now))&&part.data&&typeof part.data==='object','Дата наблюдения не подтверждена.');}
      if(part.sourceAt)assert(freshness(part.sourceAt,now)!=='invalid','Дата поставщика в будущем.');
      if(part.source)assert(safeLink(part.source),'Небезопасная ссылка поставщика.');
    }
  }
  return snapshot;
}
export function qualityFlags(review,parts={},now=Date.now()){
  const flags=[];const add=(key,text,severity='attention')=>flags.push({key,text,severity});
  if(!review)return [{key:'no-review',text:'Индивидуальный разбор этой монеты ещё не подготовлен.',severity:'attention'}];
  if(review.coverage==='limited')add('limited','Разбор ограничен: часть сведений не удалось подтвердить.');
  if(freshness(review.reviewedAt,now,30*DAY)==='stale')add('review-old','Разбор старше 30 дней. Схему выпуска и риски нужно перепроверить.');
  if(review.unlocks?.status==='unverified')add('unlocks','Полный календарь разблокировок не подтверждён.');
  for(const [i,r]of review.risks.entries())add(`risk-${i}`,r.text,r.severity);
  const observations=Object.values(parts).filter(x=>x?.data);
  if(!observations.length)add('daily-missing','Измеримые показатели пока не получены.');
  if(observations.some(x=>x.status!=='ok'||observationFreshness(x,now)!=='fresh'))add('daily-stale','Есть устаревшие показатели или сбой обновления. Смотри даты в разделах.');
  const b=parts.binance?.data;
  if(b?.monitoring===true)add('monitoring','Binance Monitoring: повышенное внимание биржи. Это ещё не объявленный делистинг.','high');
  if(b?.active===false)add('binance-pair','Активная пара USDT не подтверждена в этом снимке Binance. Это не вывод о делистинге токена.');
  if(b?.active===true&&(number(b.quoteVolume24h)&&b.quoteVolume24h<1000000||number(b.spread)&&b.spread>.003))add('liquidity','В снимке пара не проходит выбранный порог ликвидности.');
  if(parts.github?.data?.archived===true)add('archived','Выбранный официальный репозиторий архивирован. Проверь, не переехала ли разработка.');
  return flags;
}
