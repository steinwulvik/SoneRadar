const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

const envFile=path.join(__dirname,'.env');
if(fs.existsSync(envFile))for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)){const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^(["'])(.*)\1$/,'$2');}

const root = path.join(__dirname, 'dist');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 4173;
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const cache = new Map();
const TTL = 5 * 60 * 1000;
const UA = 'SoneRadar/0.2 (live area information web app)';
const MAIL_RATE_WINDOW_MS = positiveEnvInt('MAIL_RATE_WINDOW_MS', 60 * 60 * 1000);
const MAIL_RATE_LIMIT_GLOBAL = positiveEnvInt('MAIL_RATE_LIMIT_GLOBAL', 60);
const MAIL_RATE_LIMIT_PER_RECIPIENT = positiveEnvInt('MAIL_RATE_LIMIT_PER_RECIPIENT', 10);
const mailUsage = {global: [], recipients: new Map()};

function positiveEnvInt(name,fallback){const value=Number.parseInt(process.env[name]||'',10);return Number.isSafeInteger(value)&&value>0?value:fallback;}
function consumeMailQuota(address,now=Date.now()){
  const cutoff=now-MAIL_RATE_WINDOW_MS;
  mailUsage.global=mailUsage.global.filter(time=>time>cutoff);
  for(const [recipient,times] of mailUsage.recipients){const active=times.filter(time=>time>cutoff);if(active.length)mailUsage.recipients.set(recipient,active);else mailUsage.recipients.delete(recipient);}
  const recipient=address.trim().toLocaleLowerCase('en-US'),sentToRecipient=mailUsage.recipients.get(recipient)||[];
  let retryAt=0;
  if(mailUsage.global.length>=MAIL_RATE_LIMIT_GLOBAL)retryAt=Math.max(retryAt,mailUsage.global[0]+MAIL_RATE_WINDOW_MS);
  if(sentToRecipient.length>=MAIL_RATE_LIMIT_PER_RECIPIENT)retryAt=Math.max(retryAt,sentToRecipient[0]+MAIL_RATE_WINDOW_MS);
  if(retryAt)return {allowed:false,retryAfterSeconds:Math.max(1,Math.ceil((retryAt-now)/1000))};
  mailUsage.global.push(now);sentToRecipient.push(now);mailUsage.recipients.set(recipient,sentToRecipient);
  return {allowed:true,retryAfterSeconds:0};
}

async function fetchJson(url, ttl = TTL) {
  const found = cache.get(url);
  if (found?.retryUntil > Date.now()) throw new Error(`Kilden ber oss vente til ${new Date(found.retryUntil).toLocaleTimeString('nb-NO')}`);
  if (found && found.until > Date.now()) return found.value;
  const pending = (async () => {
    const response = await fetch(url, {headers:{'User-Agent':UA,Accept:'application/json'},signal:AbortSignal.timeout(25000)});
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) {
        const header=response.headers.get('Retry-After');
        const retryMs=/^\d+$/.test(header||'')?Number(header)*1000:Math.max(60000,Date.parse(header)-Date.now()||0);
        cache.set(url,{retryUntil:Date.now()+retryMs});
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const value = await response.json();
    cache.set(url,{value,until:Date.now()+ttl});
    if (cache.size > 500) for (const [key,item] of cache) if ((item.until||item.retryUntil||0) <= Date.now()) cache.delete(key);
    return value;
  })();
  cache.set(url,{value:pending,until:Date.now()+25000});
  try { return await pending; }
  catch (error) { const item=cache.get(url);if(!item?.retryUntil)cache.delete(url);throw error; }
}

function status(name,message,ok=true){return {name,message,ok};}
function smtpSend(to,subject,body){
  return new Promise((resolve,reject)=>{
    const smtpHost=process.env.SMTP_HOST||'smtp.zoho.eu',smtpPort=Number(process.env.SMTP_PORT)||465,fromName=(process.env.SMTP_FROM_NAME||'SoneRadar').replace(/[\r\n"]/g,'');
    if(smtpPort!==465){reject(new Error('SMTP-klienten er konfigurert for SSL på port 465'));return;}
    const socket=tls.connect(smtpPort,smtpHost,{servername:smtpHost});let buffer='',step=0,closed=false;
    const fail=e=>{if(closed)return;closed=true;socket.destroy();reject(e instanceof Error?e:new Error(String(e)))};
    const write=(command,expected)=>{socket.write(command+'\r\n');step=expected};
    socket.setTimeout(20000,()=>fail(new Error('Tidsavbrudd mot SMTP-serveren')));
    socket.on('error',fail);
    socket.on('data',chunk=>{buffer+=chunk.toString('utf8');let cut;while((cut=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,cut);buffer=buffer.slice(cut+2);if(/^\d{3}-/.test(line))continue;const code=Number(line.slice(0,3));try{
      if(step===0&&code===220)write('EHLO soneradar.local',1);
      else if(step===1&&code===250)write('AUTH LOGIN',2);
      else if(step===2&&code===334)write(Buffer.from(process.env.SMTP_USER).toString('base64'),3);
      else if(step===3&&code===334)write(Buffer.from(process.env.SMTP_APP_PASSWORD.replace(/\s/g,'')).toString('base64'),4);
      else if(step===4&&code===235)write(`MAIL FROM:<${process.env.SMTP_USER}>`,5);
      else if(step===5&&code===250)write(`RCPT TO:<${to}>`,6);
      else if(step===6&&(code===250||code===251))write('DATA',7);
      else if(step===7&&code===354){const safeSubject=subject.replace(/[\r\n]/g,' '),encoded=Buffer.from(body,'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');socket.write(`From: "${fromName}" <${process.env.SMTP_USER}>\r\nTo: <${to}>\r\nSubject: ${safeSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n.\r\n`);step=8;}
      else if(step===8&&code===250)write('QUIT',9);
      else if(step===9&&code===221){closed=true;socket.end();resolve();}
      else if(code>=400)fail(new Error(`SMTP-serveren svarte ${line}`));
    }catch(e){fail(e)}}});
  });
}
function distanceKm(lat1,lon1,lat2,lon2){const r=Math.PI/180,a=lat1*r,dl=(lat2-lat1)*r,dn=(lon2-lon1)*r,h=Math.sin(dl/2)**2+Math.cos(a)*Math.cos(lat2*r)*Math.sin(dn/2)**2;return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));}
function project(point,lat0,lon0){const r=Math.PI/180;return {x:(point[0]-lon0)*111.32*Math.cos(lat0*r),y:(point[1]-lat0)*111.32};}
function ringIntersectsCircle(ring,lat,lon,radius){
  const points=ring.map(p=>project(p,lat,lon));
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[i],b=points[j];
    if(((a.y>0)!==(b.y>0))&&(0<(b.x-a.x)*(0-a.y)/(b.y-a.y)+a.x))inside=!inside;
    if(Math.hypot(a.x,a.y)<=radius)return true;
    const dx=a.x-b.x,dy=a.y-b.y,len=dx*dx+dy*dy,t=len?Math.max(0,Math.min(1,(-(b.x*dx+b.y*dy))/len)):0;
    if(Math.hypot(b.x+t*dx,b.y+t*dy)<=radius)return true;
  }
  return inside;
}
function geometryIntersectsCircle(geometry,lat,lon,radius){
  if(!geometry?.coordinates)return false;
  let polygons=[];
  if(geometry.type==='Polygon')polygons=[geometry.coordinates];
  else if(geometry.type==='MultiPolygon')polygons=geometry.coordinates;
  for(const polygon of polygons){for(const ring of polygon){if(ringIntersectsCircle(ring,lat,lon,radius))return true;}}
  return false;
}
function regionIntersectsCircle(region,lat,lon,radius){
  return (region.Polygon||[]).some(poly=>{const ring=String(poly).trim().split(/\s+/).map(pair=>pair.split(',').map(Number)).filter(p=>p.length===2&&p.every(Number.isFinite)).map(([y,x])=>[x,y]);return ring.length>2&&ringIntersectsCircle(ring,lat,lon,radius);});
}
function osloDateParts(date){return Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
function dateRange(now=new Date()){
  const {year,month,day}=osloDateParts(now),start=`${year}-${month}-01`;
  const end=new Date(Date.UTC(Number(year),Number(month)-1,Number(day)+2)).toISOString().slice(0,10);
  const utcFirst=Date.UTC(Number(year),Number(month)-1,1),clock=osloDateParts(new Date(utcFirst));
  const monthStart=utcFirst-(Number(clock.hour)*60+Number(clock.minute))*60000;
  return [start,end,monthStart];
}
function fireEvent(point,centerLat,centerLon){
  const lat=Number(point.lat),lon=Number(point.lng),date=String(point.date||''),clock=String(point.time||'').padStart(4,'0');
  const time=/^\d{4}-\d{2}-\d{2}$/.test(date)&&/^\d{4}$/.test(clock)?`${date}T${clock.slice(0,2)}:${clock.slice(2)}:00Z`:date;
  const distance=distanceKm(centerLat,centerLon,lat,lon);
  return {id:`osiris-${date}-${clock}-${lat}-${lon}`,title:'Satellittmålt varmepunkt',description:`OSIRIS har registrert et satellittmålt varmepunkt omtrent ${distance.toFixed(1)} km fra sonesenteret. Dette er ikke en bekreftet skogbrann.`,source:'OSIRIS',category:'Skogbrann',precision:'Satellittmålt punkt; posisjon og brannårsak er ikke verifisert på bakken',time,lat,lon,url:'https://osirisai.live/'};
}
function textValue(value){if(value==null)return '';if(typeof value==='string'||typeof value==='number')return String(value);return JSON.stringify(value);}
function normalizeComparable(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('nb-NO').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function eventTimeMs(value){const text=String(value||'');const iso=text.match(/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/);if(iso)return Date.parse(iso[0]);const dmy=text.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?/);return dmy?new Date(+dmy[3],+dmy[2]-1,+dmy[1],+(dmy[4]||0),+(dmy[5]||0)).getTime():Date.parse(text);}
function wordsFor(e){return new Set(normalizeComparable([e.title,e.description,e.area,e.municipality].join(' ')).split(' ').filter(w=>w.length>3&&!['hendelse','hendelser','politiet','varsling','varsel','området','kommune','politiloggen'].includes(w)));}
function overlapRatio(a,b){if(!a.size||!b.size)return 0;let common=0;for(const word of a)if(b.has(word))common++;return common/Math.min(a.size,b.size);}
function eventDuplicate(a,b){if(a.id===b.id)return true;const ta=eventTimeMs(a.time),tb=eventTimeMs(b.time);if(!Number.isFinite(ta)||!Number.isFinite(tb)||Math.abs(ta-tb)>6*60*60*1000)return false;const titleA=normalizeComparable(a.title),titleB=normalizeComparable(b.title);if(titleA&&titleA===titleB)return true;return overlapRatio(wordsFor(a),wordsFor(b))>=0.72;}
function deduplicateUpdates(updates){const out=[];for(const u of updates){const text=normalizeComparable(u.text),time=eventTimeMs(u.time);if(!text)continue;const duplicate=out.some(v=>normalizeComparable(v.text)===text&&(!Number.isFinite(time)||!Number.isFinite(eventTimeMs(v.time))||Math.abs(time-eventTimeMs(v.time))<2*60*60*1000));if(!duplicate)out.push(u);}return out.sort((a,b)=>eventTimeMs(a.time)-eventTimeMs(b.time));}
function deduplicateEvents(input){const unique=[];for(const incoming of input){const match=unique.find(e=>eventDuplicate(e,incoming));if(!match){unique.push({...incoming,updates:deduplicateUpdates(incoming.updates||[])});continue;}const police=incoming.source?.includes('Politiloggen'),keep=police?incoming:match,other=police?match:incoming;const updates=deduplicateUpdates([...(keep.updates||[]),...(other.updates||[]),...(!other.updates?.length?[{time:other.time,text:other.description,source:other.source}]:[])]);Object.assign(match,keep,{updates,description:police?incoming.description:match.description,duplicateSources:[...new Set([...(match.duplicateSources||[]),keep.source,other.source].filter(Boolean))],geometry:keep.geometry||other.geometry,lat:keep.lat??other.lat,lon:keep.lon??other.lon});}return unique;}
async function liveData(params){
  const lat=Number(params.get('lat')),lon=Number(params.get('lon')),radius=Number(params.get('radius')||5),municipality=(params.get('municipality')||'').trim();
  if(!Number.isFinite(lat)||lat < -90||lat > 90||!Number.isFinite(lon)||lon < -180||lon > 180||!/^\d{4}$/.test(municipality)||!Number.isFinite(radius)||radius<1||radius>10)throw new Error('Ugyldig sted eller radius');
  const [municipalityInfo]=await fetchJson(`https://ws.geonorge.no/kommuneinfo/v1/kommuner/${municipality}`,24*60*60*1000).then(v=>[v]).catch(()=>[null]);
  const providedName=(params.get('municipalityName')||'').trim().slice(0,100);
  const municipalityName=municipalityInfo?.kommunenavnNorsk||municipalityInfo?.kommunenavn||providedName;
  if(!municipalityName)throw new Error('Kommunenavn kunne ikke slås opp. Velg en adresse fra adresselisten.');
  let municipalityFeatures=[];try{const boundaryData=await fetchJson('https://api.kartverket.no/kommuneinfo/v1/kommuner/illustrasjonskart',24*60*60*1000);municipalityFeatures=Array.isArray(boundaryData.features)?boundaryData.features:[];}catch{}
  const municipalityByCode=new Map();for(const feature of municipalityFeatures){const props=feature.properties||{},entries=Object.entries(props),codeEntry=entries.find(([k,v])=>/kommune.*(nr|nummer|kode)|kommunenr/i.test(k)&&/^\d{4}$/.test(String(v)))||entries.find(([,v])=>/^\d{4}$/.test(String(v)));const nameEntry=entries.find(([k,v])=>/kommune.*navn|kommunenavn/i.test(k)&&typeof v==='string');if(codeEntry&&nameEntry)municipalityByCode.set(String(codeEntry[1]),{code:String(codeEntry[1]),name:String(nameEntry[1]),feature});}
  const overlappingMunicipalities=[...municipalityByCode.values()].filter(m=>geometryIntersectsCircle(m.feature.geometry,lat,lon,radius));if(!overlappingMunicipalities.some(m=>m.code===municipality))overlappingMunicipalities.push({code:municipality,name:municipalityName});const municipalityNames=new Set(overlappingMunicipalities.map(m=>m.name.toLocaleLowerCase('nb-NO')));
  const events=[],sources=[],[start,end,monthStart]=dateRange();if(!municipalityByCode.size)sources.push(status('Kommunedekning','Kommunegrenser kunne ikke hentes; Politiloggen avgrenses til valgt kommune.',false));
  const tasks=[
    (async()=>{try{
      const j=await fetchJson('https://api.met.no/weatherapi/metalerts/2.0/all.json?lang=no');if(!Array.isArray(j.features))throw new Error('Uventet svarformat');
      const relevant=j.features.filter(f=>{const p=f.properties||{};return p.status==='Actual'&&p.type!=='Cancel'&&p.event!=='forestFire'&&Date.parse(p.onset||p.sent||p.effective||0)>=monthStart&&geometryIntersectsCircle(f.geometry,lat,lon,radius);});
      for(const f of relevant){const p=f.properties||{};events.push({id:`met-${p.id||p.capId}`,title:p.title||`${p.eventAwarenessName||p.event||'Farevarsel'}${p.area?' · '+p.area:''}`,description:[p.description,p.consequences,p.instruction,p.awarenessResponse&&`Råd: ${p.awarenessResponse}`,p.resources?.map(r=>r.uri).join('\n')].filter(Boolean).join('\n\n'),source:'MET Norway · MetAlerts',category:'Ekstremvær',precision:`Varselpolygon overlapper valgt radius · ${p.geographicDomain==='marine'?'havvarsel':'landvarsel'}`,time:`${p.onset||p.sent||''}${p.expires?' – '+p.expires:''}`,geometry:f.geometry,url:p.web||'https://api.met.no/weatherapi/metalerts/2.0/current.json'});}
      sources.push(status('MET MetAlerts',`${relevant.length} aktive eller utløpte denne måneden; polygoner innen ${radius} km`,true));
    }catch(e){sources.push(status('MET MetAlerts',`utilgjengelig: ${e.message}`,false));}})(),
    ...[['Flom','flood','Flomvarslingen'],['Jordskred','landslide','Jordskredvarslingen']].map(([category,type,label])=>(async()=>{try{
      const url=`https://api01.nve.no/hydrology/forecast/${type}/v1.0.10/api/Warning/Municipality/${municipality}/1/${start}/${end}`;
      const j=await fetchJson(url);if(!Array.isArray(j))throw new Error('Uventet svarformat');
      const actual=j.filter(p=>String(p.CapStatus).toLowerCase()==='actual'&&String(p.MunicipalityCsvString||'').split(/[;,]/).map(s=>s.trim()).includes(municipality));
      const active=actual.filter(p=>Number(p.ActivityLevel)>1);
      for(const p of active){events.push({id:`nve-${type}-${p.Id}-${p.ValidFrom}`,title:p.MainText||p.DangerTypeName||`${category}varsel`,description:[p.WarningText,p.CauseText,p.ConsequenceText,p.AdviceText,p.LevelMeaningText,p.NextWarningTime&&`Neste oppdatering: ${p.NextWarningTime}`].filter(Boolean).join('\n\n'),source:`Varsler fra ${label} i Norge · www.varsom.no`,category:category==='Flom'?'Flomfare':'Skredfare',precision:`Kommunevarsel for ${municipalityName} · ikke punktlokalisert`,time:`${p.ValidFrom||''}${p.ValidTo?' – '+p.ValidTo:''}`,url:'https://www.varsom.no/flom-og-jordskred/'});}
      sources.push(status(`NVE ${category}`,`${active.length} varsler på nivå 2–4 · ${actual.length} kommuneprognoser hentet for ${municipalityName}`,true));
    }catch(e){sources.push(status(`NVE ${category}`,`utilgjengelig: ${e.message}`,false));}})()),
    (async()=>{try{
      const base='https://api01.nve.no/hydrology/forecast/avalanche/v6.3.2/api';
      const regions=await fetchJson(`${base}/Region/0`,24*60*60*1000);if(!Array.isArray(regions))throw new Error('Uventet regionformat');
      const covered=regions.filter(r=>regionIntersectsCircle(r,lat,lon,radius));
      const results=await Promise.all(covered.map(async r=>({region:r,items:await fetchJson(`${base}/AvalancheWarningByRegion/Detail/${r.Id}/1/${start}/${end}`)})));
      let forecasts=0,warningCount=0;
      for(const {region,items} of results){if(!Array.isArray(items))continue;const records=items.filter(p=>!p.ValidTo||Date.parse(p.ValidTo+'Z')>=Date.now());forecasts+=records.length;
        for(const p of records){const danger=Number(p.DangerLevel);if(!Number.isFinite(danger)||danger<=1)continue;warningCount++;const parts=[p.AvalancheDanger,p.EmergencyWarning,p.SnowSurface,p.CurrentWeaklayers,p.MountainWeather,p.AvalancheProblems,p.AvalancheAdvices,p.LatestAvalancheActivity,p.LatestObservations].map(textValue).filter(Boolean);events.push({id:`nve-avalanche-${p.RegId||p.RegionId}-${p.ValidFrom}`,title:`${region.Name}: ${p.MainText||p.DangerLevelName||`faregrad ${p.DangerLevel}`}`,description:parts.join('\n\n')||'Varsom har ingen utdypende faretekst for dette varselet.',source:'Varsler fra Snøskredvarslingen i Norge · www.varsom.no',category:'Skredfare',precision:`Snøskredvarslingsregion «${region.Name}» overlapper valgt radius`,time:`${p.ValidFrom||''}${p.ValidTo?' – '+p.ValidTo:''}`,url:'https://www.varsom.no/snoskred/varsling/'});}
      }
      sources.push(status('NVE Snøskred',`${warningCount} varsler på faregrad 2–5 · ${forecasts} dagsvarsler hentet fra ${covered.length} regioner som overlapper radiusen`,true));
    }catch(e){sources.push(status('NVE Snøskred',`utilgjengelig: ${e.message}`,false));}})(),
    (async()=>{try{
      const monthEnd=Date.now();let skip=0,total=0,localCount=0;
      while(true){const url=new URL('https://api.politiloggen.politiet.no/messagethreads');url.search=new URLSearchParams({take:'200',skip:String(skip),sortByEnum:'LastMessageOn',timeSpanType:'LastQuarter'});const j=await fetchJson(url.toString(),5*60*1000);if(!Array.isArray(j.messageThreads))throw new Error('Uventet svarformat');const rows=j.messageThreads;total+=rows.length;
        for(const t of rows){const muni=String(t.municipality||t.municipalityName||'');if(muni&&!municipalityNames.has(muni.toLocaleLowerCase('nb-NO')))continue;const msgs=Array.isArray(t.messages)?t.messages:[];const updates=msgs.map(m=>({time:m.createdOn||m.updatedOn||m.time||'',text:m.text||m.message||m.description||''})).filter(m=>m.text&&Date.parse(m.time)>=monthStart&&Date.parse(m.time)<=monthEnd).sort((x,y)=>Date.parse(x.time)-Date.parse(y.time));if(!updates.length)continue;const last=updates[updates.length-1],id=String(t.id||t.messageThreadId||last.time);localCount++;events.push({id:'politi-'+id,title:String(t.category||t.title||'Politiet')+(t.area?' · '+t.area:''),description:last.text,updates,source:'Politiloggen · Politiet',category:'Politi',precision:'Melding fra '+(muni||municipalityName)+' · kommune overlapper valgt radius; ikke punktfestet',time:last.time,status:t.isActive===false||String(t.status||'').toLowerCase().includes('avsluttet')?'Avsluttet':'Pågående',url:'https://api.politiloggen.politiet.no/messagethreads/'+encodeURIComponent(id)});}
        if(j.hasMoreResults!==true||!rows.length)break;skip+=rows.length;
      }
      sources.push(status('Politiloggen',total+' meldingsforløp gjennomgått; '+localCount+' hendelser fra kommunene '+overlappingMunicipalities.map(m=>m.name).join(', '),true));
    }catch(e){sources.push(status('Politiloggen','utilgjengelig: '+e.message,false));}})(),
    (async()=>{try{
      const j=await fetchJson('https://osirisai.live/api/fires',60*1000);if(!Array.isArray(j.fires))throw new Error('Uventet svarformat');
      const now=Date.now(),local=j.fires.filter(p=>String(p.type).toLowerCase()==='fire'&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng))&&distanceKm(lat,lon,Number(p.lat),Number(p.lng))<=radius).map(p=>fireEvent(p,lat,lon)).filter(e=>{const time=eventTimeMs(e.time);return Number.isFinite(time)&&time>=monthStart&&time<=now});
      events.push(...local);
      sources.push(status('OSIRIS',`${local.length} satellittmålinger denne måneden innenfor ${radius} km i OSIRIS sin livefeed`,true));
    }catch(e){sources.push(status('OSIRIS',`utilgjengelig: ${e.message}`,false));}})(),
  ];
  await Promise.allSettled(tasks);
  const uniqueEvents=deduplicateEvents(events);uniqueEvents.sort((a,b)=>eventTimeMs(b.time)-eventTimeMs(a.time));
  return {events:uniqueEvents,sources,generatedAt:new Date().toISOString(),selected:{lat,lon,radius,municipality,municipalityName,municipalities:overlappingMunicipalities.map(m=>({code:m.code,name:m.name}))}};
}

function sendJson(res,code,value,headers={}){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));}
const server=http.createServer(async(req,res)=>{
  let url;try{url=new URL(req.url,'http://localhost');}catch{res.writeHead(400).end();return;}
  if(url.pathname==='/api/live'&&req.method==='GET'){
    try{sendJson(res,200,await liveData(url.searchParams));}catch(e){sendJson(res,400,{error:e.message});}return;
  }
  if(url.pathname==='/api/smtp-test'&&req.method==='POST'){
    if(!process.env.SMTP_USER||!process.env.SMTP_APP_PASSWORD){sendJson(res,503,{error:'E-post er ikke konfigurert ennå'});return;}
    try{let body='';for await(const chunk of req){body+=chunk;if(body.length>2000)throw new Error('Ugyldig forespørsel');}const payload=JSON.parse(body||'{}'),to=String(payload.to||'').trim(),place=String(payload.place||'sted').trim().slice(0,80);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))throw new Error('Skriv inn en gyldig varslingsadresse');const quota=consumeMailQuota(to);if(!quota.allowed){sendJson(res,429,{error:'E-postgrensen er nådd. Prøv igjen senere.',retryAfterSeconds:quota.retryAfterSeconds},{'Retry-After':String(quota.retryAfterSeconds)});return;}await smtpSend(to,`Varsel om hendelse i: ${place}`,`Dette er en testmelding fra SoneRadar for stedet ${place}.`);sendJson(res,200,{sent:true});}catch(e){sendJson(res,502,{error:e.message});}return;
  }
  if(url.pathname==='/api/notify'&&req.method==='POST'){
    if(!process.env.SMTP_USER||!process.env.SMTP_APP_PASSWORD){sendJson(res,503,{error:'E-post er ikke konfigurert ennå'});return;}
    try{let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw new Error('E-postmelding er for stor');}const payload=JSON.parse(body),to=String(payload.to||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))throw new Error('Ugyldig e-postadresse');const events=Array.isArray(payload.events)?payload.events:[];if(events.length>20)throw new Error('Maks 20 hendelser per e-postbatch');if(!events.length){sendJson(res,200,{sent:false});return;}const quota=consumeMailQuota(to);if(!quota.allowed){sendJson(res,429,{error:'E-postgrensen er nådd. Prøv igjen senere.',retryAfterSeconds:quota.retryAfterSeconds},{'Retry-After':String(quota.retryAfterSeconds)});return;}const place=String(payload.place||'sted').slice(0,80),text=`SoneRadar har registrert ${events.length===1?'en ny hendelse':'nye hendelser'} i området ${place}.\n\n${events.map((e,i)=>[`HENDELSE ${events.length>1?i+1:''}`.trim(),e.title||'Varsel',e.description||'Kilden har ikke oppgitt en nærmere beskrivelse av hendelsen.','Kilde: '+(e.source||'Ukjent'), 'Tid: '+(e.time||'Tid ikke oppgitt')].join('\n')).join('\n\n────────────────────\n\n')}`;await smtpSend(to,`Varsel om hendelse i: ${place}`,text);sendJson(res,200,{sent:true,count:events.length});}catch(e){sendJson(res,400,{error:e.message});}return;
  }
  if(url.pathname.startsWith('/api/')){sendJson(res,404,{error:'API-endepunktet finnes ikke'});return;}
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{res.writeHead(400).end();return;}
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,body)=>{if(error){res.writeHead(404).end('Ikke funnet');return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);});
});
server.listen(port,host,()=>console.log(`SoneRadar live: http://${host}:${port} — Ctrl+C stopper serveren.`));
server.on('error',error=>{console.error(error.message);process.exitCode=1;});





