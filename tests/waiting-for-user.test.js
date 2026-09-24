const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../index');

test('all user question snapshots are Chinese while callback data stays token based', () => {
  const command = _test.formatCommandApprovalMessage({ command: 'ls -la', reason: '查看目录', guard: '只读' });
  const file = _test.formatFileApprovalMessage({ title: 'README.md', reason: '更新说明' });
  const text = _test.formatTextInputMessage({ header: '需要输入', question: '项目名？', token: 'tok' });
  const multi = _test.formatMultipleInputMessage();
  assert.match(command, /是否允许执行这条命令？/);
  assert.match(command, /保护规则：只读/);
  assert.match(command, /原因：查看目录/);
  assert.match(file, /是否允许修改文件？/);
  assert.match(file, /原因：更新说明/);
  assert.match(text, /请直接回复：\/answer tok 你的回答/);
  assert.equal(multi, '暂不支持一次回答多个问题，已跳过，任务继续');
  assert.doesNotMatch(`${command}\n${file}\n${text}\n${multi}`, /Approve|Accept|Deny|Reply with/);
  assert.match('appr|tok|acceptForSession', /^appr\|tok\|acceptForSession$/);
});

test('approval wait edits the existing ack to Chinese waiting state', async () => {
  const edits = [];
  const manager = new _test.TelegramAckManager({
    send: async () => ({ message_id: 41 }),
    edit: async params => { edits.push(params); },
    minEditIntervalMs: 0,
  });
  const ack = await manager.start({ chatId: 7, requestId: 'wait01' });
  await manager.update(ack, 'processing');
  await manager.update(ack, 'waitingForUser', { reason: '拒绝' });
  assert.equal(edits.at(-1).message_id, 41);
  assert.match(edits.at(-1).text, /等你回答.*10 分钟.*拒绝/);
});

test('approval button resumes processing and five-minute reminder replies only once', async () => {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const setTimer = (fn, delay) => { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; };
  const clearTimer = id => timers.delete(id);
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); await timer.fn(); }
  };
  const edits = [];
  const reminders = [];
  const manager = new _test.TelegramAckManager({
    now: () => now, minEditIntervalMs: 0,
    send: async () => ({ message_id: 41 }), edit: async params => { edits.push(params); },
  });
  const ack = await manager.start({ chatId: 7, requestId: 'wait02' });
  await manager.update(ack, 'processing');
  const actions = new Map();
  const waiter = _test.createTelegramActionWait({
    kind: 'approval', chatId: 7, token: 'tok', pendingActions: actions,
    ackManager: manager, ack, sendMessage: async params => { reminders.push(params); },
    setTimer, clearTimer,
  });
  await waiter.ready;
  waiter.setQuestionMessageId(77);
  assert.match(edits.at(-1).text, /等你回答/);
  await advance(5 * 60 * 1000);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].reply_to_message_id, 77);
  assert.match(reminders[0].text, /5 分钟后将自动拒绝/);
  await actions.get('tok').resolve('decline');
  assert.equal(await waiter.promise, 'decline');
  assert.match(edits.at(-1).text, /正在处理/);
  assert.doesNotMatch(edits.at(-1).text, /等你回答/);
  await advance(5 * 60 * 1000);
  assert.equal(reminders.length, 1);
});

test('ten-minute timeout resumes with Chinese skip note and waiting state suppresses stall notice', async () => {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const setTimer = (fn, delay) => { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; };
  const clearTimer = id => timers.delete(id);
  const edits = [];
  const manager = new _test.TelegramAckManager({
    now: () => now, minEditIntervalMs: 0,
    send: async () => ({ message_id: 41 }), edit: async params => { edits.push(params); },
  });
  const ack = await manager.start({ chatId: 7, requestId: 'wait03' });
  await manager.update(ack, 'processing');
  const entries = [{ requestId: 'wait03', chatId: 7, state: 'running' }];
  const stall = new _test.TelegramStallMonitor({ activeRequests: { list: () => entries }, ackManager: manager, now: () => now });
  stall.markRunning('wait03');
  const actions = new Map();
  const waiter = _test.createTelegramActionWait({
    kind: 'userInputText', chatId: 7, token: 'tok2', pendingActions: actions,
    ackManager: manager, ack, sendMessage: async () => {}, setTimer, clearTimer,
  });
  await waiter.ready;
  waiter.setQuestionMessageId(77);
  now = 5 * 60 * 1000;
  await stall.tick();
  assert.doesNotMatch(edits.at(-1).text, /没有新进展/);
  now = 10 * 60 * 1000;
  for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); await timer.fn(); }
  assert.equal(await waiter.promise, null);
  assert.match(edits.at(-1).text, /正在处理/);
  assert.match(edits.at(-1).text, /10 分钟未回复，已自动跳过，任务继续/);
  assert.equal(actions.size, 0);
});
