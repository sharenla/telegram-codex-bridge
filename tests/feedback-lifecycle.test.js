const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../index');

test('lifecycle notice is appended to the existing ack and disappears at terminal state', async () => {
  const edits = [];
  const manager = new _test.TelegramAckManager({
    send: async () => ({ message_id: 91 }),
    edit: async params => { edits.push(params); },
    minEditIntervalMs: 0,
  });
  const ack = await manager.start({ chatId: 7, requestId: 'life01' });
  await manager.update(ack, 'processing');
  await manager.appendLifecycleNote(ack, '🔄 当前账号异常，正在切换备用账号重试（第 2 个）');
  assert.match(edits.at(-1).text, /正在切换备用账号重试/);
  assert.equal(edits.at(-1).message_id, 91);
  await manager.update(ack, 'completed');
  assert.doesNotMatch(edits.at(-1).text, /正在切换备用账号重试/);
});
