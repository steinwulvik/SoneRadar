const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('server.cjs','utf8'),start=source.indexOf('const MAIL_RATE_WINDOW_MS'),end=source.indexOf('\nasync function fetchJson',start);
assert.ok(start>=0&&end>start,'Mail rate limiting is configured before data fetching');
let now=1_000_000;class TestDate extends Date{static now(){return now}}
const context={Map,Date:TestDate,process:{env:{MAIL_RATE_WINDOW_MS:'3600000',MAIL_RATE_LIMIT_GLOBAL:'3',MAIL_RATE_LIMIT_PER_RECIPIENT:'2'}}};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
const use=address=>vm.runInContext(`consumeMailQuota(${JSON.stringify(address)})`,context);
assert.equal(use('User@example.com').allowed,true);
assert.equal(use('user@example.com').allowed,true,'Recipient matching is case-insensitive');
const repeated=use('USER@example.com');assert.equal(repeated.allowed,false,'Per-recipient hourly limit is enforced');assert.equal(repeated.retryAfterSeconds,3600);
assert.equal(use('other@example.com').allowed,true);
const global=use('third@example.com');assert.equal(global.allowed,false,'Global hourly limit is enforced');
now+=3600001;assert.equal(use('third@example.com').allowed,true,'Quota resets after the rolling window');
assert.ok(vm.runInContext('mailUsage.global.length<=1',context),'Expired global timestamps are cleaned');
assert.ok(vm.runInContext('mailUsage.recipients.size<=1',context),'Expired recipient buckets are cleaned');
assert.match(source,/\/api\/smtp-test'[\s\S]*?consumeMailQuota\(to\)/,'SMTP test endpoint shares the mail quota');
assert.match(source,/\/api\/notify'[\s\S]*?consumeMailQuota\(to\)/,'Notification endpoint shares the mail quota');
console.log('PASS: mail rate caps, recipient normalization, Retry-After delay, expiry cleanup and coverage of both mail endpoints');
