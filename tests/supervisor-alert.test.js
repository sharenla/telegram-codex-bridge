const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const script = path.resolve(__dirname, '../scripts/codex-launch-supervisor.sh');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-supervisor-alert-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const curlLog = path.join(root, 'curl.log');
  fs.writeFileSync(path.join(bin, 'curl'), `#!${process.execPath}
const fs=require('fs');fs.appendFileSync(${JSON.stringify(curlLog)},JSON.stringify({argv:process.argv.slice(2),stdin:fs.readFileSync(0,'utf8')})+'\\n');
`, {mode:0o755});
  const codex = path.join(root, 'fake-codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nif(process.argv.includes('--version'))process.exit(0);setInterval(()=>{},1000);`, {mode:0o755});
  fs.writeFileSync(path.join(root,'index.js'), `const {spawn}=require('child_process');let c;setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(path.join(root,'healthy'))})&&!c)c=spawn(${JSON.stringify(codex)},['app-server','--listen','stdio://']);},20);process.on('SIGTERM',()=>{if(c)c.kill();process.exit(0)});`);
  fs.writeFileSync(path.join(root,'.env'), 'TELEGRAM_BOT_TOKEN=123456:SECRET_TOKEN\nTELEGRAM_ALLOWLIST=123,-456,789\n');
  fs.mkdirSync(path.join(root,'data/logs'),{recursive:true});
  fs.writeFileSync(path.join(root,'data/logs/bridge.stderr.log'),'failed request https://example.test/x?token=secret&x=1 bot123:SECRET_TOKEN\n');
  const child=spawn('/bin/zsh',[script],{cwd:root,detached:true,stdio:'ignore',env:{PATH:`${bin}:${process.env.PATH}`,BRIDGE_ROOT:root,NODE_BIN:process.execPath,CODEX_BIN:codex,BRIDGE_INSTANCE_ID:'fixture',POLL_INTERVAL:'0.05',APP_SERVER_MISS_LIMIT:'1',START_GRACE_SECONDS:'0',LOG_ROTATE_CHECK_INTERVAL:'999999',...arguments[1]}});
  t.after(async()=>{try{process.kill(-child.pid,'SIGTERM')}catch{} await delay(100);try{process.kill(-child.pid,'SIGKILL')}catch{} fs.rmSync(root,{recursive:true,force:true});});
  const read=()=>{try{return fs.readFileSync(curlLog,'utf8')}catch{return ''}};
  const logs=()=>{try{return fs.readFileSync(path.join(root,'data/logs/bridge.stdout.log'),'utf8')+fs.readFileSync(path.join(root,'data/logs/bridge.stderr.log'),'utf8')}catch{return ''}};
  const wait=async(pred)=>{for(let i=0;i<300;i++){if(pred())return;await delay(30)}assert.fail(logs())};
  return {root,read,logs,wait};
}
test('supervisor sends one redacted private alert after three unhealthy restarts and no duplicate in 30m', {timeout:20000}, async t=>{
 const f=await fixture(t); await f.wait(()=>f.read().split('\n').filter(Boolean).length>=1);
 await delay(500); const rows=f.read().split('\n').filter(Boolean).map(JSON.parse); assert.equal(rows.length,2);
 assert.match(rows[0].argv.join(' '),/连续 3 次启动失败/); assert.match(rows[0].argv.join(' '),/123/); assert.doesNotMatch(rows[0].argv.join(' '),/SECRET_TOKEN/); assert.doesNotMatch(rows[0].argv.join(' '),/SECRET_TOKEN/);
});
test('supervisor sends recovery only after a prior alert and targets no groups', {timeout:20000}, async t=>{
 const f=await fixture(t); await f.wait(()=>f.read().split('\n').filter(Boolean).length>=1);
 fs.writeFileSync(path.join(f.root,'healthy'),'yes'); await f.wait(()=>f.read().split('\n').filter(Boolean).length>=4 && /\"active\":false/.test(fs.readFileSync(path.join(f.root,'data/supervisor-alert.json'),'utf8'))); const rows=f.read().split('\n').filter(Boolean).map(JSON.parse);
 assert.equal(rows.length,4); assert.match(rows[2].argv.join(' '),/已恢复/); assert.doesNotMatch(rows[2].argv.join(' '),/456/);
 assert.match(fs.readFileSync(path.join(f.root,'data/supervisor-alert.json'),'utf8'),/\"active\":false/);
});
test('a recovered alert keeps its 30 minute cooldown across supervisor restart', {timeout:15000}, async t => {
 const f=await fixture(t);
 fs.writeFileSync(path.join(f.root,'data/supervisor-alert.json'), JSON.stringify({alertedAt:Math.floor(Date.now()/1000),failureCount:3,active:false}));
 await delay(700);
 assert.equal(f.read().trim(),'');
});
