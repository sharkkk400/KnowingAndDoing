import gzip,json,csv,subprocess,sys
from pathlib import Path
root=Path('data/minute-research/decade-480/daily')
args=["node","--input-type=module","-e","import {instruments} from './dist/instruments.js';console.log(JSON.stringify(instruments.filter(d=>d.sector.endsWith('ETF'))))"]
names={i['symbol']:i for i in json.loads(subprocess.check_output(args))}
def get(s):return json.load(gzip.open(root/(s+'.json.gz')))
ds=sorted(get('sh510300')['adjusted']);data={s:get(s) for s in names if (root/(s+'.json.gz')).exists()}
leaders={};rows=[];watch=[]
for i,d in enumerate(ds):
 if d<'2016-11-18' or d>'2026-11-18':continue
 if not leaders or ds[i-1][:7]!=d[:7]:
  picks=[]
  for s,a in data.items():
   if s=='sh511010':continue
   adj=a['adjusted'];vals=[adj.get(t,0) for t in ds[i-61:i]]
   if len(vals)!=61 or min(vals)<=0 or vals[-1]<=vals[-21] or vals[-1]<=sum(vals[-20:])/20:continue
   strength=vals[-1]/vals[0]-1
   if strength>0:picks.append((strength,s))
  picks.sort(reverse=True)
  leaders[d]=picks[0][1] if picks else None
  for rank,(strength,s) in enumerate(picks,1):watch.append([d,rank,s[2:],names[s]['name'],round(100*strength,2)])
for year in range(2017,2027):
 days=[t for t in ds if t.startswith(str(year)) and t<='2026-11-18'];last=days[-1];start=ds[ds.index(days[0])-1];res=[]
 for s,a in data.items():
  v=a['adjusted'];bars={b['date']:b for b in a['bars']}
  if v.get(start,0)>0 and v.get(last,0)>0 and bars.get(start,{}).get('volume',0)>0 and bars.get(last,{}).get('volume',0)>0:
   ret=100*((v[last]/v[start])*(1-.0003)/(1+.0003)-1);res.append((ret,s))
 res.sort(reverse=True)
 print(year,len(res),sum(r>0 for r,s in res),[(names[s]['name'],s,round(r,1)) for r,s in res[:3]])
 for r,s in res:rows.append([year,s[2:],names[s]['name'],round(r,3)])
with open('outputs/弱收益年ETF方向与全年可比收益.csv','w',encoding='utf-8-sig') as f:
 w=csv.writer(f);w.writerow(['年份（2026截至11月18日）','代码','名称','上年末收盘至期末复权收益率（扣双边万三，%）']);w.writerows(rows)
with open('outputs/全池月初独立强势方向.csv','w',encoding='utf-8-sig') as f:
 w=csv.writer(f);w.writerow(['数据可用日','排名','代码','名称','前60日收益%']);w.writerows(watch)
if len(sys.argv)>1:
 with open(sys.argv[1],'w') as f:json.dump(leaders,f)
