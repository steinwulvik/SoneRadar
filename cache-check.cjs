const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('server.cjs','utf8'),start=source.indexOf('async function fetchJson'),end=source.indexOf('\nfunction status',start);
assert.ok(start>=0&&end>start,'Server fetch cache implementation exists');
let calls=0,release;const context={Map,Date,AbortSignal,UA:'SoneRadar test',TTL:300000,cache:new Map(),fetch:()=>{calls++;return new Promise(resolve=>{release=resolve})}};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
(async()=>{
 const one=vm.runInContext("fetchJson('https://source.invalid/month')",context),two=vm.runInContext("fetchJson('https://source.invalid/month')",context);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1,'Concurrent identical source requests are coalesced');
 release({ok:true,json:async()=>({events:10071})});
 const [a,b]=await Promise.all([one,two]);assert.equal(a.events,10071);assert.equal(b.events,10071);
 await vm.runInContext("fetchJson('https://source.invalid/month')",context);assert.equal(calls,1,'Successful data remains cached for its TTL');
 context.fetch=async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '60'}}};
 await assert.rejects(vm.runInContext("fetchJson('https://source.invalid/rate')",context),/429/);
 await assert.rejects(vm.runInContext("fetchJson('https://source.invalid/rate')",context),/vente/);
 assert.equal(calls,2,'Retry-After prevents a request storm');
 console.log('PASS: server cache coalescing, large payload caching, TTL reuse and Retry-After backoff');
})().catch(e=>{console.error(e);process.exitCode=1});
