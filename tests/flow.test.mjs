import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {FlowStore,parseFlow} from '../flow.mjs';
const fixture=(date='2026-10-08',minute='14:30',main='30')=>({rc:0,data:{code:'600519',klines:[`${date} ${minute},${main},-10,-20,10,20`]}});
test('field mapping and missing/invalid payloads',()=>{
 const p=parseFlow(fixture(),'sh600519');assert.equal(p.main,30);assert.equal(p.small,-10);assert.equal(p.superLarge,20);assert.equal(p.date,'2026-10-08');
 assert.throws(()=>parseFlow({rc:0,data:null},'sh600519'));
 assert.throws(()=>parseFlow(fixture(),'sz300750'));
 assert.throws(()=>parseFlow(fixture('2026-10-08','14:30','-'),'sh600519'));
 assert.throws(()=>parseFlow(fixture('2026-10-08','14:30','999'),'sh600519'));
});
test('deduplication, date isolation, concurrency and restart persistence',async()=>{
 const dir=await mkdtemp(tmpdir()+'/gp-flow-test-');
 try{const url=pathToFileURL(dir+'/');const a=new FlowStore(url);await a.load();
 const p=parseFlow(fixture(),'sh600519','2026-10-08T06:30:10Z');await a.add(p);await a.add({...p,collectedAt:'2026-10-08T06:31:10Z'});assert.equal(a.latest(p.symbol).samples.length,1);assert.equal(a.latest(p.symbol).snapshot.collectedAt,p.collectedAt);
 await Promise.all([a.add(parseFlow(fixture('2026-10-08','14:31'),'sh600519')),a.add(parseFlow(fixture('2026-10-08','14:32'),'sh600519'))]);assert.equal(a.latest(p.symbol).samples.length,3);
 await a.add(parseFlow(fixture('2026-10-09','09:31'),'sh600519'));assert.equal(a.latest(p.symbol).samples.length,1);
 const b=new FlowStore(url);await b.load();assert.equal(b.latest(p.symbol).snapshot.date,'2026-10-09');assert.equal(b.data['sh600519|2026-10-08'].length,3);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('minute series restores earlier rows, validates every row and never invents gaps',async()=>{
 const {parseFlowSeries}=await import('../flow.mjs');
 const data=fixture();data.data.klines=[fixture('2026-10-08','14:32').data.klines[0],fixture().data.klines[0],fixture().data.klines[0]];
 const rows=parseFlowSeries(data,'sh600519');assert.equal(rows.length,2);assert.equal(rows[0].sourceTime.slice(11,16),'14:30');assert.equal(rows[1].sourceTime.slice(11,16),'14:32');
 assert.throws(()=>parseFlowSeries({...data,data:{...data.data,klines:['2026-10-08 14:29,999,-10,-20,10,20',...data.data.klines]}},'sh600519'));
 assert.throws(()=>parseFlowSeries(fixture('2026-10-08','14:99'),'sh600519'));
 assert.throws(()=>parseFlowSeries(fixture('2026-10-08','14:30'),'sh600519','2026-10-08T06:00:00Z'));
 const dir=await mkdtemp(tmpdir()+'/gp-flow-batch-');
 try{const url=pathToFileURL(dir+'/'),a=new FlowStore(url);await a.load();
 const last={...rows[1],market:{price:100},collectedAt:'2026-10-08T06:32:10Z'};await a.add(last);await a.addMany(rows);await a.addMany(rows);
 assert.equal(a.latest(last.symbol).samples.length,2);assert.equal(a.latest(last.symbol).snapshot.market.price,100);assert.equal(a.latest(last.symbol).snapshot.collectedAt,last.collectedAt);
 const b=new FlowStore(url);await b.load();assert.deepEqual(b.latest(last.symbol),a.latest(last.symbol));
 }finally{await rm(dir,{recursive:true,force:true});}
});
