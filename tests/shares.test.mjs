import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mergeShares,analyzeShares} from '../shares-analysis.mjs';
import {parseSse,parseSzse} from '../shares.mjs';
import {shareEvidence} from '../daily-candidates.mjs';
const defs=[{symbol:'sh510300',exposure:'hs300'}];
const dates=Array.from({length:25},(_,i)=>new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10));
const series=dates.map((date,i)=>({symbol:'sh510300',date,shares:1000+i*10}));
test('SSE converts ten-thousand shares, checks returned date and pagination',()=>{
 const r={SEC_CODE:'510300',STAT_DATE:'2026-01-02',TOT_VOL:'1,234.56'};
 assert.equal(parseSse({result:[r]},r.STAT_DATE)[0].shares,12345600);
 assert.throws(()=>parseSse({result:[r]},'2026-01-01'));
 assert.throws(()=>parseSse({result:[r],pageHelp:{total:2}},r.STAT_DATE));
 assert.throws(()=>parseSse({result:[{...r,TOT_VOL:''}]},r.STAT_DATE));
});
test('SZSE parses official XLSX inline strings, strips code padding and preserves units',async()=>{
 const code=`import io,zipfile,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('xl/worksheets/sheet1.xml','''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="inlineStr"><is><t>日期</t></is></c><c r="B1" t="inlineStr"><is><t>基金代码</t></is></c><c r="C1" t="inlineStr"><is><t>基金规模(份)</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>2026-10-09</t></is></c><c r="B2" t="inlineStr"><is><t>159740  </t></is></c><c r="C2" t="inlineStr"><is><t>1,234.00</t></is></c></row></sheetData></worksheet>''')
sys.stdout.buffer.write(b.getvalue())`;
 const rows=await parseSzse(execFileSync('python3',['-c',code]));assert.equal(rows[0].shares,1234);assert.equal(rows[0].symbol,'sz159740');
 await assert.rejects(parseSzse(Buffer.from('<html>blocked</html>')));
});
test('merge is idempotent, applies corrected values and survives JSON persistence',()=>{
 let rows=mergeShares(series,series);assert.equal(rows.length,25);
 rows=mergeShares(rows,[{...series[0],shares:900}]);assert.equal(rows[0].shares,900);
 assert.deepEqual(mergeShares([],JSON.parse(JSON.stringify(rows))),rows);
 assert.throws(()=>mergeShares(rows,[{...series[0],shares:NaN}]));
});
test('full windows use trading dates; gaps do not become daily changes or continuous streaks',()=>{
 const n=analyzeShares(defs,series,dates).items[0];assert.equal(n.day.delta,10);assert.equal(n.five.delta,50);assert.equal(n.twenty.delta,200);assert.equal(n.streak,24);
 const missing=series.filter((_,i)=>i!==23),r=analyzeShares(defs,missing,dates);assert.equal(r.ready,false);assert.equal(r.items[0].day.ready,false);assert.equal(r.items[0].five.ready,false);assert.equal(r.items[0].streak,0);
 const lag=analyzeShares(defs,series.slice(0,-1),dates);assert.equal(lag.count,0);assert.equal(lag.items[0].lag,1);
});
test('possible split blocks flow inference across affected windows, excludes future data',()=>{
 const rows=series.map((r,i)=>({...r,shares:i===24?r.shares*2:r.shares}));
 const n=analyzeShares(defs,rows,dates).items[0];assert.equal(n.day.ready,false);assert.equal(n.twenty.ready,false);assert.equal(n.streak,0);
 const r=analyzeShares(defs,[...series,{...series[0],date:'2027-01-01',shares:1}],dates);assert.equal(r.items[0].date,dates.at(-1));
});
test('price comparison and daily candidate evidence never combine different dates or failed sources',()=>{
 const bars=dates.map((date,i)=>({date,close:100+i}));
 const result=analyzeShares(defs,series,dates,new Map([['sh510300',{bars}]])),s=result.items[0];
 assert.equal(s.relation,'价格上涨、份额增加');assert.match(shareEvidence(s,dates.at(-2)),/日期不同/);
 assert.match(shareEvidence(s,dates.at(-1),{sources:{sh:{error:'offline'}}}),/来源异常/);
 assert.equal(analyzeShares(defs,series,dates,new Map([['sh510300',{bars:bars.slice(0,-1)}]])).items[0].relation,null);
});
test('duplicated tracking exposure has only one vote and needs all products',()=>{
 const ds=[...defs,{symbol:'sh510050',exposure:'hs300'}],rows=[...series,...series.map(r=>({...r,symbol:'sh510050'}))];
 const r=analyzeShares(ds,rows,dates);assert.equal(r.units,1);assert.equal(r.up,1);
 assert.equal(analyzeShares(ds,series,dates).units,0);
});

test('share unit conversion noise does not fabricate a change; conflicting products are separate',()=>{
 const clean=mergeShares([],[{...series[0],shares:7122366800.000001}]);assert.equal(clean[0].shares,7122366800);
 const ds=[...defs,{symbol:'sh510050',exposure:'hs300'}];
 const rows=[...series,...series.map((r,i)=>({...r,symbol:'sh510050',shares:2000-i*10}))];
 const r=analyzeShares(ds,rows,dates);assert.equal(r.split,1);assert.equal(r.up,0);assert.equal(r.down,0);assert.equal(r.flat,0);
});
