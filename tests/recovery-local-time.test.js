const test=require('node:test');const assert=require('node:assert/strict');
const { _test:{TelegramRecoveryNotices,TelegramOutbox} }=require('../index.js');
function summary(start,end,shutdown) {
 const store={data:{telegram:{health:{lastPollSuccessAt:start,offlineSince:start,lastPollError:'SSL connection reset',lastShutdown:shutdown}}},save(){}};
 const outbox=new TelegramOutbox(store,{send:async()=>({message_id:1})});
 const recovery=new TelegramRecoveryNotices({store,outbox,allowlist:new Set([1]),getBotName:()=> 'rv_bot',now:()=>end,logger(){}});
 recovery.onPollSuccess([]);return store.data.telegram.outbox[0].params.text;
}
test('network outage precedes shutdown: recovery keeps network reason and mentions restart',()=>{
 const start=new Date(2026,8,23,20,29,30).getTime();
 const text=summary(start,new Date(2026,8,23,20,55,31).getTime(),{at:new Date(2026,8,23,20,33,0).getTime(),graceful:true});
 assert.match(text,/代理或网络连接中断/);assert.match(text,/期间服务进程也曾重启/);
});
test('summary timestamps use local seconds; dates appear only across local days',()=>{
 const start=new Date(2026,8,23,20,29,30).getTime();
 const same=summary(start,new Date(2026,8,23,20,55,31).getTime());
 assert.match(same,/20:29:30 – 20:55:31/);assert.doesNotMatch(same,/\dT|\dZ|2026-09-23/);
 const cross=summary(start,new Date(2026,8,24,0,1,2).getTime());
 assert.match(cross,/09-23 20:29:30 – 09-24 00:01:02/);assert.doesNotMatch(cross,/\dT|\dZ/);
});
