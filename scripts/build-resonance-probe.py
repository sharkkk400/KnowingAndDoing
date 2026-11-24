import json,datetime,collections,statistics
from pathlib import Path
from resonance.analysis.core import eval_day
from resonance.analysis.composite import analyze_single_etf,calc_composite_probability
from resonance.analysis.factors import calc_share_probability_dual
from base.analysis.sentiment.core import enrich_turnover,turnover_value,percentile_series
x=json.load(open('data/resonance-review/inputs.json'));raw=json.load(open('data/minute-research/annual-daily.json')); adj=json.load(open('data/minute-research/annual-adjusted.json'))
import sys,gzip
decade='--decade-480' in sys.argv
directory=Path('data/minute-research/decade-480')
if decade:
 for symbol in ['sh000300','sh510050','sh510300']:
  archive=json.load(gzip.open(directory/'daily'/(symbol+'.json.gz')))
  raw[symbol],adj[symbol]=archive['bars'],archive['adjusted']
 history=json.load(open(directory/'turnover.json'))
 for key,recent in x['turnover'].items():
  x['turnover'][key]={**history[key.split('.')[1]],**recent}
ix=raw['sh000300'];dates=[r['date'] for r in ix]; idx={r['date']:r for r in ix};rows=json.load(open('data/etf-share-history.json'))['rows']
for l in open('data/etf-share-observations.jsonl'):
 rr=json.loads(l);rows.extend(rr if isinstance(rr,list) else [rr])
v=collections.defaultdict(list)
for r in rows:
 if r.get('symbol') in ('sh510300','sh510050'):v[r['symbol'],r['date']].append((r['fetchedAt'],r['shares']/1e8))
a,b=x['turnover'].values();turn=enrich_turnover([dict(date=d,total_amount_yi=(a[d]+b[d])) for d in sorted(a.keys()&b.keys())]);tp=percentile_series([r['date'] for r in turn],[turnover_value(r) for r in turn],60,20);md=sorted(x['margin']);mp=percentile_series(md,[x['margin'][d] for d in md],60,20)
out={}
for mode in ['strict','backfill']:
 green=set()
 for s in ['sh510300','sh510050']:
  bs=[dict(r,**{k:r[k]*adj[s][r['date']]/r['close'] for k in ['open','high','low','close']}) for r in raw[s] if r['date'] in idx and r['date'] in adj[s]]; ib=[idx[r['date']] for r in bs]
  for n,r in enumerate(bs[:-1]):
   if n<59:continue
   d=r['date'];cut=bs[n+1]['date']+'T00:00:00.000Z'
   def shares(j):
    return next((val for t,val in sorted(v[s,bs[j]['date']],reverse=True) if mode=='backfill' or t<cut),None)
   cur,prev=shares(n),shares(n-1); ch=100*(cur/prev-1) if cur and prev else None
   row=analyze_single_etf(bs,ib,ch,n);hist=[z for j in range(n-10,n) if (z:=shares(j)) is not None]
   sp=calc_share_probability_dual(ch,cur,hist) if ch is not None else None
   cp=lambda score:calc_composite_probability(row['vol_prob'],row['dir_prob'],score,row['price_position'])
   # A missing share probability can only support a green composite if every possible score does.
   row.update(share_prob=sp,composite_prob=cp(sp) if sp is not None else min(cp(i) for i in range(101)))
   lights=eval_day(row,tp.get(d,{}).get('percentile'),mp.get(d,{}).get('percentile') if mode=='backfill' else None,s[2:])
   if list(lights.values()).count('green')>=3:green.add(d)
 def above(j):return ix[j]['close']>statistics.mean(r['close'] for r in ix[j-19:j+1])
 eligible={dates[j+1]:[d for d in dates[j-5:j] if d in green] for j in range(60,len(dates)-1) if above(j) and not above(j-1) and green.intersection(dates[j-5:j])}
 out[mode]=eligible;print(mode,len(green),len(eligible),[(k,z) for k,z in eligible.items() if k.startswith('2024-09')])
(directory/'five-day-probe.json' if decade else Path('data/resonance-review/five-day-probe.json')).write_text(json.dumps(out,sort_keys=True))
