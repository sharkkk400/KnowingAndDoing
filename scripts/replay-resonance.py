"""Run with PYTHONPATH pointed at the pinned Resonance backend."""
import json
from pathlib import Path
from collections import defaultdict
from base.analysis.sentiment.core import enrich_turnover, turnover_value, percentile_series
from base.analysis.strategy.router import compute_trades
from resonance.analysis.composite import analyze_single_etf
from resonance.analysis.factors import calc_share_probability_dual
from resonance.analysis.composite import calc_composite_probability
from portfolio.analysis.simulator import simulate

root = Path(__file__).resolve().parents[1] / 'data'
data = json.loads((root/'resonance-review/inputs.json').read_text())
shares = defaultdict(dict)
for r in sorted(json.loads((root/'etf-share-history.json').read_text())['rows'],key=lambda r:r['fetchedAt']):
    shares[r['symbol'][2:]][r['date']] = r['shares']/1e8
def bars(code):
    return [dict(date=r[0], open=float(r[1]), close=float(r[2]), high=float(r[3]), low=float(r[4]), volume=float(r[5])) for r in data['prices'][code]]
idx = {r['date']:r for r in bars('000300')}
a,b = data['turnover'].values()
turn = enrich_turnover([dict(date=d,total_amount_yi=round(a[d]+b[d],2)) for d in sorted(a.keys()&b.keys())])
tp = percentile_series([r['date'] for r in turn],[turnover_value(r) for r in turn],60,20)
md = sorted(data['margin'])
mp = percentile_series(md,[data['margin'][d] for d in md],60,20)
allrows,prices,signals={},{},{}
dates=[d for d in sorted(idx) if '2025-01-22'<=d<='2026-11-18']
for code in data['prices']:
    if code=='000300':continue
    series=bars(code)
    aligned=[idx[r['date']] for r in series]
    prices[code]={r['date']:r['close'] for r in series}
    out=[]
    for i,r in enumerate(series):
        d=r['date']; val=shares[code].get(d)
        prev=shares[code].get(series[i-1]['date']) if i else None
        delta=val-prev if val and prev else None
        pct=100*delta/prev if delta is not None else None
        v=analyze_single_etf(series,aligned,pct,i)
        if not v:continue
        sp=calc_share_probability_dual(pct,val,[shares[code][k['date']] for k in series[max(0,i-10):i] if k['date'] in shares[code]])
        v.update(code=code,close_price=r['close'],shares_yi=val,shares_delta_yi=delta,share_prob=sp,
                 composite_prob=calc_composite_probability(v['vol_prob'],v['dir_prob'],sp,v['price_position']))
        out.append(v)
    allrows[code]=out
for code,rows in allrows.items():
    result=compute_trades(code,rows,t_pct=tp,m_pct=mp,hs300_rows=allrows['510300'],kc50_rows=allrows['588000'])
    signals[code]=[r for r in result['trades'] if r['date'] in dates]

def stats(nav):
    peak=nav[0];dd=pct=0
    for v in nav:
        peak=max(peak,v);dd=max(dd,peak-v);pct=max(pct,1-v/peak)
    return [round(nav[-1]-nav[0]),round(dd),round(100*pct,2)]
def fixed(capital):
    cash=capital;book={};nav=[cash];counts=[0,0,0];fees=.001
    for i,d in enumerate(dates):
        orders=sorted((r['action']!='SELL',c,r['action']) for c,rr in signals.items() for r in rr if i and r['date']==dates[i-1])
        for _,c,action in orders:
            price=prices[c][d]
            if action=='SELL' and c in book:
                cash+=book.pop(c)*price*(1-fees);counts[1]+=1
            if action=='BUY' and c not in book:
                if len(book)>=3 or cash<30000*(1+fees):counts[2]+=1;continue
                book[c]=30000/price;cash-=30000*(1+fees);counts[0]+=1
        nav.append(cash+sum(q*prices[c][d] for c,q in book.items()))
    return nav,counts
raw=simulate(signals,prices,dates)
print('observations',len(dates),dates[0],dates[-1])
for c in allrows:
    res=simulate({c:signals[c]},prices,dates)
    print(c,len([r for r in signals[c] if r['action']=='BUY']),res['total_return_pct'],res['max_drawdown_pct'])
cut=dates.index('2026-10-21')
nav=[1]+[h['equity'] for h in raw['history']]
print('native',raw['total_return_pct'],raw['max_drawdown_pct'],'post revision',round((nav[-1]/nav[cut]-1)*100,2))
for cap in [90000,180000]:
    nav,counts=fixed(cap)
    print(cap,stats(nav),counts,'post revision',stats(nav[cut:]),'later period profit',round(nav[-1]-nav[dates.index('2026-05-08')]))
benchmark=[idx[d]['close']/idx[dates[0]]['close'] for d in dates]
print('HS300 price return/dd',round((benchmark[-1]-1)*100,2),stats(benchmark)[2], 'post-revision sessions',len(dates)-cut)

def managed(capital, trim, add, rotate):
    cash=capital; book={}; nav=[cash]; counts=defaultdict(int)
    fee=.001; ticket=30000; cost=ticket*(1+fee)
    lookup={c:{r['date']:j for j,r in enumerate(rows)} for c,rows in allrows.items()}
    def strength(c,d):
        j=lookup[c][d]
        return allrows[c][j]['close_price']/allrows[c][j-20]['close_price']-1 if j>=20 else float('-inf')
    for i,d in enumerate(dates):
        if i==0:
            nav.append(cash);continue
        prev=dates[i-1]
        orders=sorted((r['action']!='SELL',c,r['action']) for c,rr in signals.items() for r in rr if r['date']==prev)
        for _,c,action in orders:
            if action=='SELL' and c in book:
                cash+=book.pop(c)['q']*prices[c][d]*(1-fee)
        recovering=[]
        for c,p in book.items():
            j=lookup[c][prev];v=[r['close_price'] for r in allrows[c][max(0,j-19):j+1]]
            if len(v)<20:continue
            weak=v[-1]<sum(v)/20
            if trim and weak and not p['weak']:
                cash+=p['q']/2*prices[c][d]*(1-fee);p['q']/=2;counts['trim']+=1
            if not weak and p['weak'] and not p['added']:recovering.append(c)
            p['weak']=weak
        for _,c,action in orders:
            if action!='BUY' or c in book:continue
            if len(book)==3 and rotate:
                old=min(book,key=lambda s:(strength(s,prev),s))
                proceeds=book[old]['q']*prices[old][d]*(1-fee)
                if strength(c,prev)>strength(old,prev) and cash+proceeds>=cost:
                    cash+=proceeds;del book[old];counts['rotate']+=1
            if len(book)<3 and cash>=cost:
                cash-=cost;book[c]=dict(q=ticket/prices[c][d],weak=False,added=False)
        for c in sorted(recovering):
            if add and c in book and cash>=cost:
                cash-=cost;book[c]['q']+=ticket/prices[c][d];book[c]['added']=True;counts['add']+=1
        assert len(book)<=3 and cash>=0
        nav.append(cash+sum(p['q']*prices[c][d] for c,p in book.items()))
    return nav,dict(counts)

for cap in [90000,180000]:
    for label,t,a,r in [('base',0,0,0),('trim',1,0,0),('add',0,1,0),('rotate',0,0,1),('all',1,1,1)]:
        n,k=managed(cap,t,a,r)
        if label=='base':assert n==fixed(cap)[0]
        print('manage',cap,label,stats(n)[:2],k,'late profit',round(n[-1]-n[dates.index('2026-05-08')]))
