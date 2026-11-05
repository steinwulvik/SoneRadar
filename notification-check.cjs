const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map(),stored={zones:[{id:'zone-1',name:'Teststed',address:'Testgate 1',lat:59.9,lon:10.7,radius:5,municipality:'0301',email:'test@example.invalid'}],selected:'zone-1',seenEvents:{'zone-1':[]},mailBaseline:{'zone-1':new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit'}).format(new Date()).split('/').reverse().join('-')}};
const events=Array.from({length:41},(_,i)=>({id:`event-${i}`,title:`Hendelse ${i}`,description:'Testhendelse',source:'Testkilde',category:'Politi',time:new Date(Date.now()-i*1000).toISOString(),geometry:{coordinates:['X'.repeat(150000)]}}));
let storedValue=JSON.stringify(stored),failSecondBatch=true;const batches=[],bodies=[];
function node(){return {textContent:'',firstChild:{textContent:''},innerHTML:'',value:'',disabled:false,style:{},classList:{toggle(){}},showModal(){},close(){},append(){},addEventListener(){}}}
const context={console,setInterval:()=>0,Map,Number,String,Date,Math,JSON,Promise,Array,URLSearchParams,TextEncoder,crypto:require('node:crypto').webcrypto,AbortSignal,localStorage:{getItem:()=>storedValue,setItem:(_,v)=>storedValue=v},document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,node());return nodes.get(s)},querySelectorAll:()=>[]},fetch:async(url,options={})=>{if(String(url).startsWith('/api/live?'))return {ok:true,status:200,json:async()=>({events,sources:[]})};const body=JSON.parse(options.body);bodies.push(body);batches.push(body.events.map(e=>e.id));const fail=batches.length===2&&failSecondBatch;if(batches.length===2)failSecondBatch=false;return {ok:true,status:200,json:async()=>fail?{sent:false}:{sent:true,count:body.events.length}}}};
vm.createContext(context);vm.runInContext(fs.readFileSync('dist/app.js','utf8'),context);
(async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(batches.map(b=>b.length),[20,20],'Notification payloads are capped at 20 events');
 const afterFailure=JSON.parse(storedValue).seenEvents['zone-1'];
 assert.equal(afterFailure.length,20,'Only confirmed successful batches are marked sent');
 await vm.runInContext('load()',context);
 assert.deepEqual(batches.slice(2).map(b=>b.length),[20,1],'Failed events are retried in batches without resending successful events');
 assert.equal(JSON.parse(storedValue).seenEvents['zone-1'].length,41,'All confirmed notifications are eventually marked sent');
 assert.ok(bodies.every(b=>b.events.every(e=>!('geometry'in e))),'Large map geometries are excluded from email requests');
 assert.ok(bodies.every(b=>Buffer.byteLength(JSON.stringify(b))<90000),'Email request bodies remain below the server limit');
 console.log('PASS: 41-event batching, partial delivery tracking, and retry without duplicate sends');
})().catch(e=>{console.error(e);process.exitCode=1});
