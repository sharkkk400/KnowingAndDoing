import {createResearchStore} from './research-store.mjs';
import {getDailyFlow} from './flow-daily.mjs';
import {backfillDaily} from './daily-history.mjs';
import {getShares,startSharesCollector} from './shares.mjs';
import {getDailyCandidates} from './daily-candidates.mjs';
import {getMarketContext,getBreadth} from './market-context.mjs';
import {getMacd} from './macd.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {getQuotes,getIntraday,instruments} from './market.mjs';
import {getFlow,watchlist,startFlowSampler} from './flow.mjs';
import {getNews,startNewsCollector} from './news.mjs';
import {createForecastArchive} from './forecast-archive.mjs';
import {createForecastCollector} from './forecast-collector.mjs';
import {createResearchHandler} from './research-api.mjs';
import {createStrategyAdvisor,createStrategyHandler} from './strategy-advice.mjs';
import {weakWatchFactors} from './pentad-policy.mjs';
import {createMorningPlanner,createMorningHandler} from './morning-plan.mjs';
import {getDaily} from './market-context.mjs';
import {createExecutionMonitor,createExecutionHandler} from './plan-execution.mjs';
await startFlowSampler();
await startNewsCollector();
await startSharesCollector();
const archive=createForecastArchive();
const forecastCollector=createForecastCollector(archive);
const researchHandler=createResearchHandler({archive,forecastCollector});
const strategyHandler=createStrategyHandler({advisor:createStrategyAdvisor(),getDaily:getDailyCandidates,getQuotes});
const positions=createResearchStore(new URL('./data/position-log.json',import.meta.url),{version:1,records:[]});
const morningPlanner=createMorningPlanner({getDaily,getNews,positions,getWeakWatchFactors:weakWatchFactors,getEvents:async()=>(await executionMonitor.read()).records});
const morningHandler=createMorningHandler(morningPlanner,Date.now,positions);
const executionMonitor=createExecutionMonitor({planner:morningPlanner,positions,getQuotes,getIntraday,getMacd});
const executionHandler=createExecutionHandler(executionMonitor);
morningPlanner.start();
executionMonitor.start();
forecastCollector.start();
void backfillDaily().catch(e=>console.error('日线补齐：'+e.message));
void getDailyCandidates().catch(e=>console.error('候选跟踪：'+e.message));
setInterval(()=>void getDailyCandidates().catch(e=>console.error('候选跟踪：'+e.message)),300000).unref();
const files={'/outlook.js':'outlook.js','/news-market.js':'news-market.js','/etf-capital.js':'etf-capital.js','/focus-summary.js':'focus-summary.js','/shares.js':'shares.js','/etf-insights.js':'etf-insights.js','/etf-overview.js':'etf-overview.js','/instruments.js':'instruments.js','/market-analysis.js':'market-analysis.js','/price-volume.js':'price-volume.js','/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js','/news.js':'news.js'};
Object.assign(files,{'/research.js':'research.js','/research-markup.js':'research-markup.js','/instrument-advice.js':'instrument-advice.js','/market-advice.js':'market-advice.js','/strategy-markup.js':'strategy-markup.js'});
Object.assign(files,{'/morning.js':'morning.js','/morning-markup.js':'morning-markup.js'});
Object.assign(files,{'/execution-markup.js':'execution-markup.js'});
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(await morningHandler(req,res,url))return;
  if(await executionHandler(req,res,url))return;
  if(await researchHandler(req,res,url))return;
  if(await strategyHandler(req,res,url))return;
  if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'只支持读取'});
  if(url.pathname.startsWith('/api/')){
    try{
      if(url.pathname==='/api/daily-history')return json(res,200,await backfillDaily());
      if(url.pathname==='/api/etf-shares')return json(res,200,await getShares());
      if(url.pathname==='/api/daily-candidates')return json(res,200,await getDailyCandidates());
      if(url.pathname==='/api/market-breadth')return json(res,200,await getBreadth());
      if(url.pathname==='/api/market-context'){const symbol=url.searchParams.get('symbol');if(!instruments.some(i=>i.symbol===symbol&&(i.sector==='指数'||i.sector.endsWith('ETF'))))return json(res,400,{error:'无效市场参照'});return json(res,200,await getMarketContext(symbol));}
      if(url.pathname==='/api/news')return json(res,200,getNews());
      if(url.pathname==='/api/quotes')return json(res,200,await getQuotes());
      if(url.pathname==='/api/macd'){const symbol=url.searchParams.get('symbol');if(!instruments.some(i=>i.symbol===symbol))return json(res,400,{error:'无效标的'});return json(res,200,await getMacd(symbol));}
      if(url.pathname==='/api/intraday'){
        const symbol=url.searchParams.get('symbol');
        if(!instruments.some(i=>i.symbol===symbol))return json(res,400,{error:'无效标的'});
        return json(res,200,await getIntraday(symbol));
      }
      if(url.pathname==='/api/money-flow-daily'){
        const symbol=url.searchParams.get('symbol');
        if(!watchlist.some(i=>i.symbol===symbol))return json(res,400,{error:'无效自选标的'});
        return json(res,200,await getDailyFlow(symbol));
      }
      if(url.pathname==='/api/money-flow'){
        const symbol=url.searchParams.get('symbol');
        if(!watchlist.some(i=>i.symbol===symbol))return json(res,400,{error:'无效自选标的'});
        return json(res,200,getFlow(symbol));
      }
      return json(res,404,{error:'接口不存在'});
    }catch{return json(res,502,{error:'行情源暂不可用，请稍后重试'});}
  }
  const file=files[url.pathname];if(!file){res.writeHead(404);return res.end('Not found');}
  try{const data=await readFile(new URL(`./dist/${file}`,import.meta.url));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(data);}catch{res.writeHead(500);res.end('Unable to load page');}
}).listen(5178,'127.0.0.1',()=>console.log('http://127.0.0.1:5178'));
