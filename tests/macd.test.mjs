import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseKlines,calculateMacd} from '../macd.mjs';
test('MACD uses EMA12/26/9, doubles histogram and separates forming bars',()=>{
 const base={time:'2026-10-09T15:00:00+08:00',open:10,close:10,volume:100};
 const steady=calculateMacd(Array.from({length:110},()=>({...base})));assert.equal(steady.at(-1).dif,0);assert.equal(steady.at(-1).histogram,0);assert.equal(steady[99].warmed,false);assert.equal(steady[100].warmed,true);
 const r=calculateMacd([base,{...base,close:11}],Date.parse(base.time)-1);const dif=2/13-2/27;
 assert(Math.abs(r[1].dif-dif)<1e-12);assert(Math.abs(r[1].dea-dif*.2)<1e-12);assert(Math.abs(r[1].histogram-2*dif*.8)<1e-12);assert.equal(r[1].confirmed,false);
 assert.equal(calculateMacd([base],Date.parse(base.time)+2000)[0].confirmed,true);
});
test('strict JSONP parsing does not execute script and rejects invalid candles',()=>{
 const row={day:'2026-10-09 15:00:00',open:'10',close:'11',high:'12',low:'9',volume:'100'};
 const wrap=r=>'var k=('+JSON.stringify(r)+');';assert.equal(parseKlines(wrap([row,row])).length,1);assert.throws(()=>parseKlines('var k=(alert(1));'));assert.throws(()=>parseKlines(wrap([{...row,high:'9'}])));assert.throws(()=>parseKlines(wrap([{...row,day:'2026-10-09 12:15:00'}])));
});
