"""Monthly stock/bond allocation grid. All signal inputs predate the opening auction."""
import json, gzip, statistics, sys
from pathlib import Path
from functools import lru_cache
from itertools import product
from math import floor
root=Path(__file__).resolve().parents[1]/'data/minute-research/decade-480/daily'
def asset(code):
    data=json.load(gzip.open(root/(code+'.json.gz')))
    return {b['date']:b for b in data['bars']}, data['adjusted']
equity,bond='sh510300','sh511010'
assets={s:asset(s) for s in (equity,bond)}
all_days=sorted(assets[equity][0])
prior_day=dict(zip(all_days[1:],all_days[:-1]))
dates=[d for d in all_days if '2016-11-18'<=d<='2026-11-18']
@lru_cache(None)
def above(symbol,d,lookback):
    if not lookback:return True
    i=all_days.index(d)
    history=[assets[symbol][1].get(t) for t in all_days[i-lookback:i]]
    return len(history)==lookback and all(v and v>0 for v in history) and history[-1]>statistics.mean(history)
def simulate(days,risk,eq_ma,bond_ma,fee):
    units={equity:0.,bond:0.};cash=100000.;peak=cash;nav=[cash];dd=0.;trades=0;month=None
    for d in days:
        total=cash;marks={}
        for s,(bars,adj) in assets.items():
            b=bars[d]
            marks[s]=b['open']*adj[d]/b['close']
            total+=units[s]*marks[s]
        if month!=d[:7]:
            month=d[:7]
            # Target lots are frozen from prior NAV and closing prices. Opening prices determine fills.
            budget=min(100000,nav[-1]);w=(risk/100 if above(equity,d,eq_ma) else 0)
            weights={equity:w,bond:(1-w if above(bond,d,bond_ma) else 0)}
            targets={s:floor(budget*weights[s]/(assets[s][0][prior_day[d]]['close']*100))*100 for s in assets}
            for sell in (True,False):
                for s in assets:
                    raw=assets[s][0][d]['open'];mv=units[s]*marks[s]
                    delta=targets[s]*raw-mv
                    if sell and delta<0:
                        gross=mv if targets[s]==0 else floor((-delta+1e-7)/(raw*100))*raw*100
                        if gross>1e-6:
                            cash+=gross*(1-fee);units[s]-=gross/marks[s];trades+=1
                    if not sell and delta>0:
                        gross=floor(min(delta+1e-7,cash/(1+fee))/(raw*100))*raw*100
                        if gross>0:
                            cash-=gross*(1+fee);units[s]+=gross/marks[s];trades+=1
        value=cash+sum(units[s]*assets[s][1][d] for s in assets)
        assert cash>=-1e-6 and all(u>=-1e-6 for u in units.values())
        peak=max(peak,value);dd=max(dd,1-value/peak);nav.append(value)
    return {'start':days[0],'end':days[-1],'profit':nav[-1]-100000,'dd':dd*100,'trades':trades,'nav':nav if len(days)>400 else None}
if __name__=='__main__':
    windows=[dates]+[[d for d in dates if d[:4]==y] for y in sorted({d[:4] for d in dates})]
    for risk,eq_ma,bond_ma in product([10,20,30,40],[0,60,120],[0,60]):
        for ds in windows:
            row=simulate(ds,risk,eq_ma,bond_ma,.0003)
            print('stability',json.dumps(dict(id=f'monthly-{risk}-{eq_ma}-{bond_ma}',**row)))
