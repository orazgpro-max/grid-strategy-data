// Public website metadata; Binance does not document tags in the Spot API contract.
// Missing/changed metadata is unknown, never evidence that a coin has no tag.
export const MONITORING_API='https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true';
export const MONITORING_SOURCE='https://www.binance.com/en/markets/coinInfo-Monitoring';
const CACHE_MS=5*60*1000;
const identifier=value=>typeof value==='string'&&/^[\p{L}\p{N}]{1,80}$/u.test(value);

export function parseMonitoring(payload,fetchedAt){
  if(payload?.success!==true||payload.code!=='000000'||!Array.isArray(payload.data)||!payload.data.length||payload.data.length>10000||!Number.isFinite(fetchedAt))throw new Error('Структура отметок Binance не подтверждена.');
  const bySymbol=new Map(),seen=new Set();let hasMonitoring=false;
  for(const row of payload.data){
    if(!identifier(row?.s)||!identifier(row.b)||!identifier(row.q)||row.s!==row.b+row.q||typeof row.st!=='string'||!Array.isArray(row.tags)||row.tags.some(tag=>typeof tag!=='string')||seen.has(row.s))throw new Error('Неполные или неоднозначные отметки Binance.');
    seen.add(row.s);
    const tagged=row.tags.some(tag=>tag.trim().toLowerCase()==='monitoring');
    hasMonitoring ||= tagged;
    if(row.q==='USDT'&&row.st==='TRADING')bySymbol.set(row.s,tagged);
  }
  // With this undocumented feed, a vanished tag vocabulary cannot safely mean zero risk tags.
  if(!hasMonitoring||!bySymbol.size)throw new Error('Категория Monitoring не подтверждена источником.');
  return {bySymbol,fetchedAt};
}

export function createMonitoringClient({fetch=globalThis.fetch,now=Date.now,timeoutMs=10000}={}){
  let cached=null,pending=null;
  async function request(){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetch(MONITORING_API,{method:'GET',credentials:'omit',signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw new Error(`Binance HTTP ${response.status}`);
      const result=parseMonitoring(await response.json(),now());cached=result;return result;
    }catch(error){cached=null;throw error;}
    finally{clearTimeout(timer);}
  }
  return {load({force=false}={}){
    if(pending)return pending;
    const age=cached?now()-cached.fetchedAt:Infinity;
    if(!force&&age>=0&&age<CACHE_MS)return Promise.resolve(cached);
    pending=request().finally(()=>{pending=null;});return pending;
  }};
}

const client=createMonitoringClient();
const timeFormat=value=>new Date(value).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});

export function mountMonitoring({root=document,load=client.load}={}){
  const status=root.getElementById('watchlist-monitoring-status'),selected=root.getElementById('market-monitoring');
  if(!status||!selected)return {attach(){},setActive(){},refresh:async()=>{}};
  const badges=new Map();let snapshot=null,activeSymbol=null,pending=null,generation=0,phase='idle';
  function state(symbol){return snapshot?.bySymbol.get(symbol);}
  function render(){
    for(const [symbol,badge] of badges){
      const tag=state(symbol);
      badge.textContent=tag===true?'⚠ Monitoring Binance':tag===false?'Monitoring: нет отметки':'Monitoring: нет данных';
      badge.className=`monitoring-badge${tag===true?' monitoring-warning':''}`;
      badge.title=`${symbol.replace(/USDT$/,'')}: ${tag===true?'Binance отмечает повышенный риск. Это не объявление о делистинге.':tag===false?'Источник Binance не содержит Monitoring Tag для этой пары. Это не гарантия сохранения листинга.':'Статус Monitoring не подтверждён.'}${snapshot?` Получено ${timeFormat(snapshot.fetchedAt)}.`:''} Открыть список Binance.`;
      badge.setAttribute('aria-label',badge.title);
    }
    status.textContent=phase==='loading'?'Monitoring: проверяем Binance…':snapshot?`Monitoring: получено ${timeFormat(snapshot.fetchedAt)}. При выборе монеты кэш до 5 минут; кнопка обновляет заново.`:'Monitoring: данные не получены. Статус монет не подтверждён; попробуй обновить позже.';
    selected.hidden=!activeSymbol;
    const tag=state(activeSymbol),coin=activeSymbol?.replace(/USDT$/,'')??'';
    selected.className=`market-monitoring${tag===true?' monitoring-warning':''}`;
    selected.textContent=`${coin} · ${tag===true?'⚠ Monitoring Binance: повышенный риск':tag===false?'Monitoring Binance: нет отметки':'Monitoring Binance: нет данных'}${snapshot?` · ${timeFormat(snapshot.fetchedAt)}`:''}`;
    selected.title=tag===true?'Монета под наблюдением Binance. Это не объявленный делистинг.':'Отсутствие Monitoring Tag не гарантирует сохранение листинга. Статус не заменяет объявления Binance.';
  }
  function refresh({force=false}={}){
    if(pending&&!force)return pending;
    const run=++generation;phase='loading';snapshot=null;render();
    const task=(async()=>{
      try{const result=await load({force});if(run===generation){snapshot=result;phase='ready';}}
      catch{if(run===generation){snapshot=null;phase='error';}}
      finally{if(run===generation){pending=null;render();}}
    })();pending=task;return task;
  }
  function attach(symbol,wrapper){
    const badge=root.createElement('a');badge.href=MONITORING_SOURCE;badge.target='_blank';badge.rel='noopener noreferrer';
    wrapper.append(badge);badges.set(symbol,badge);render();
  }
  function setActive(symbol){activeSymbol=symbol;render();void refresh();}
  render();return {attach,setActive,refresh};
}
