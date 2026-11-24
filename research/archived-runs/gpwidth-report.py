from pathlib import Path
import json,csv,collections,itertools
nav=collections.defaultdict(dict); waits=collections.defaultdict(list);tr=collections.defaultdict(dict);k=None
for l in open(Path(__file__).resolve().parent / 'gpwidth.log'):
 if l.startswith('defenseCase '):k=l.split()[1];entry=None
 elif l.startswith('waitDay '):waits[k].append(l.split()[1])
 elif l.startswith('journal '):
  j=json.loads(l[8:]);nav[k][j['date']]=j['nav']
 elif l.startswith('sleeve '):
  d,s,a,g=json.loads(l[7:])
  if s=='sh510300':
   if a=='买入':entry=d;cost=g*1.0003
   elif entry and a=='清仓':tr[k][entry]=(d,g*.9997-cost);entry=None
assert len(nav['turn'])==1666 and round(list(nav['weak-core8'].values())[-1])==242958
out=[]
for k in ['weak-core8','turn','always','50','70','80','80omit']:
 p=h=150000;dd=0;annual=[]
 for y,rows in itertools.groupby(nav[k].items(),lambda t:t[0][:4]):
  for _,n in rows:h=max(h,n);dd=max(dd,1-n/h)
  annual.append(round(100*(n/p-1),2));p=n
 out.append([k,round(n-150000,2),round(dd*100,3),len(waits[k]),*annual]);print(out[-1],waits[k]);print('12 pnl',round(sum(v[1] for v in tr[k].values()),2));print('worst',min(r[1] for r in tr[k].values()))
for d,(e,v) in tr['turn'].items():
 if d in tr['weak-core8'] and abs(v-tr['weak-core8'][d][1])>.01:print(d,e,round(tr['weak-core8'][d][1]),round(v),round(v-tr['weak-core8'][d][1]))
with open(Path(__file__).resolve().parents[2] / 'outputs/反弹试仓广度过滤延迟退出整账户.csv','w',encoding='utf-8-sig') as f:
 w=csv.writer(f);w.writerow(['方案','净赚元','最大回撤%','延迟次数',*range(2020,2027)]);w.writerows(out)
