const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../index');

test('user-facing failure reasons are Chinese and group text never includes raw upstream details', () => {
  assert.equal(_test.classifyUserFacingFailure('ETIMEDOUT while fetch failed'), '网络连接中断');
  assert.equal(_test.classifyUserFacingFailure('Codex backend is unavailable'), 'Codex 后端暂时不可用');
  assert.equal(_test.classifyUserFacingFailure('context window token limit exceeded'), '对话上下文过长，建议 /new 开启新对话后重发');
  assert.equal(_test.classifyUserFacingFailure('thread not found: thread_abc'), '对话已失效，请重发');
  const group = _test.formatUserFacingFailure({ errorText: '502 Bad Gateway at https://example.invalid/?token=secret', group: true });
  assert.equal(group, 'Telegram 服务端暂时不可用');
  assert.doesNotMatch(group, /Bad Gateway|https?:\/\//);
  const privateText = _test.formatUserFacingFailure({ errorText: '502 Bad Gateway', group: false });
  assert.match(privateText, /^Telegram 服务端暂时不可用（502 Bad Gateway）$/);
});

test('stop and answer feedback is Chinese while callback labels keep their token protocol', () => {
  assert.equal(_test.formatStopNotice({ active: false }), '当前没有进行中的任务');
  assert.equal(_test.formatStopNotice({ active: false, clearedCount: 2 }), '当前没有进行中的任务，已清空排队的 2 条');
  assert.equal(_test.formatStopNotice({ active: true, clearedCount: 1 }), '已请求停止，已清空排队的 1 条');
  assert.equal(_test.formatStopNotice({ active: true }), '已请求停止');
  assert.equal(_test.formatApprovalCallbackLabel('accept'), '允许');
  assert.equal(_test.formatApprovalCallbackLabel('acceptForSession'), '本会话都允许');
  assert.equal(_test.formatApprovalCallbackLabel('decline'), '拒绝');
});
