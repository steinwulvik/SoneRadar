const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const nodes=new Map();
const saved={zones:[{id:'actual-location',name:'Teststed',address:'Testgate 1, 0123 OSLO',lat:59.91,lon:10.75,radius:5,municipality:'0301'}],selected:'actual-location'};
const context={console,setInterval:()=>0,Map,Number,String,Date,Math,JSON,Promise,Array,URLSearchParams,crypto:require('node:crypto').webcrypto,AbortSignal,localStorage:{getItem:()=>JSON.stringify(saved),setItem(){}},document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,{textContent:'',firstChild:{textContent:''},innerHTML:'',value:'',disabled:false,style:{},classList:{toggle(){}},showModal(){},close(){},append(){},addEventListener(){}});return nodes.get(s)},querySelectorAll:()=>[]},fetch:async()=>({ok:true,status:200,json:async()=>({events:[],sources:[]})})};
vm.createContext(context);vm.runInContext(fs.readFileSync('dist/app.js','utf8'),context);
(async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext('distanceKm({lat:0,lon:0},{lat:0,lon:0})',context),0);
 assert.ok(Math.abs(vm.runInContext('distanceKm({lat:0,lon:0},{lat:0,lon:1})',context)-111.195)<0.01);
 let calls=0;
 context.fetch=async()=>{calls++;return {ok:false,status:429,headers:new Headers({'Retry-After':'120'})}};
 await assert.rejects(vm.runInContext("get('https://example.invalid/rate')",context),/429/);
 await assert.rejects(vm.runInContext("get('https://example.invalid/rate')",context),/vente/);
 assert.equal(calls,1,'Retry-After must suppress another request');
 context.fetch=async()=>{calls++;return {ok:true,headers:new Headers(),json:async()=>({ok:true})}};
 await vm.runInContext("get('https://example.invalid/cache')",context);await vm.runInContext("get('https://example.invalid/cache')",context);
 assert.equal(calls,2,'Cached requests must not hit source again');
 context.fetch=async()=>{throw Error('offline')};
 await vm.runInContext('load()',context);
 assert.equal(vm.runInContext('data.length',context),0,'Source failure must not substitute synthetic events');
 assert.ok(vm.runInContext("statuses.some(s=>s.includes('utilgjengelig'))",context));
 console.log('PASS: geographical distance, Retry-After, cache, explicit offline state and no generated fallback');
})().catch(e=>{console.error(e);process.exitCode=1});


