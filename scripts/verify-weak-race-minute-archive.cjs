// Usage from GP: node scripts/verify-weak-race-minute-archive.cjs raw-month-directory local-sina-decoder.cjs
const fs=require('fs'),z=require('zlib'),decode=require(require('node:path').resolve(process.argv[3]));
const dest='data/minute-research/weak-top-ten/',source=require('node:path').resolve(process.argv[2])+'/';let total=0,accepted=0,corrected=0,delayed=0;
const quarters={};
for(const name of fs.readdirSync(source).filter(n=>/^(sh|sz)\d{6}-\d{4}-\d{2}\.js$/.test(n))){
 const symbol=name.split('-')[0],m=name.slice(9,16),idx=symbol==='sh000300';
 const daily=new Map(JSON.parse(z.gunzipSync(fs.readFileSync('data/minute-research/decade-480/daily/'+symbol+'.json.gz'))).bars.map(b=>[b.date,b]));
 const out={};for(const packet of fs.readFileSync(source+name,'utf8').split('"')[1].split(',').filter(Boolean)){
  let b;try{b=decode(packet)}catch{continue}
  if(b?.length!==243||!b[0].date)continue;
  const date=b[0].date.toISOString().slice(0,10),bar=daily.get(date);if(!bar||date.slice(0,7)!==m)continue;
  total++;const data=b.slice(1),first=data.findIndex(x=>x.price>0),tol=idx?.00501:.000001;
  if(first<0||!data.slice(0,first).every(x=>x.price===0&&x.volume===0)||!data.slice(first).every(x=>Number.isFinite(x.price)&&x.price>=bar.low-tol&&x.price<=bar.high+tol))continue;
  const volume=b.reduce((a,q)=>a+q.volume,0),volumeOK=Math.abs(volume-bar.volume*100)<=101;
  const p=data.map(x=>x.price);
  // Individual historical quarter closes may be verifiable even when the complete minute tape is not.
  if(!idx&&(volumeOK||Math.abs(b[0].price-bar.open)<.00001||Math.abs(p[241]-bar.close)<=.00101)){
   const q=quarters[symbol]??={};
   for(let i=15;i<=241;i++)if((i<=120?i%15===0:i>121&&(i-121)%15===0)&&i>=first&&p[i]>0){
    const t=i<=120?570+i:780+i-121;
    q[date+' '+String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0')+':00']=i===241?bar.close:p[i];
   }
  }
  if(Math.abs(p[241]-bar.close)>(idx?.00501:.00101)){
   if(idx&&Math.abs(b[0].price-bar.open)<=.00501){p[241]=bar.close;corrected++}else if(!idx&&volumeOK&&Math.abs(b[0].price-bar.open)<.00001&&data[241].volume===0){p[241]=bar.close;corrected++}else continue;
  }
  if(!idx&&first>0&&first<15&&Math.abs(p[241]-bar.close)<=.00101){
   const q=(quarters[symbol]??={});
   for(let i=15;i<=241;i++)if(i<=120?i%15===0:i>121&&(i-121)%15===0){
    const t=i<=120?570+i:780+i-121;
    q[date+' '+String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0')+':00']=p[i];
   }
  }
  if(first&&!(volumeOK||(!idx&&first<15&&Math.abs(b[0].price-bar.open)<.00001&&p[241]===bar.close)))continue;
  out[date]={p,first};accepted++;if(first)delayed++;
 }
 if(Object.keys(out).length)fs.writeFileSync(dest+name.replace('.js','.json.gz'),z.gzipSync(JSON.stringify(out)));
}fs.mkdirSync(dest+'quarters',{recursive:true});fs.writeFileSync(dest+'quarters/observed.json.gz',z.gzipSync(JSON.stringify(quarters)));console.log({total,accepted,corrected,delayed})
