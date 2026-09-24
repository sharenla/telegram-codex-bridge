const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../index');

test('T4.4c narrows failure classification before context matching', () => {
  assert.equal(_test.classifyUserFacingFailure('context deadline exceeded'), '网络连接超时');
  assert.equal(_test.classifyUserFacingFailure('request timed out'), '网络连接超时');
  assert.equal(_test.classifyUserFacingFailure('context window exceeded'), '对话上下文过长，建议 /new 开启新对话后重发');
  assert.equal(_test.classifyUserFacingFailure('503 Service Unavailable'), '上游服务暂时不可用');
});

test('T4.4c keeps ordinary turn failures on the existing ack when one exists', () => {
  assert.equal(_test.formatTurnFailureNotification({ ackCount: 1, errorText: '503 upstream failed', group: true }), null);
  assert.equal(
    _test.formatTurnFailureNotification({ ackCount: 0, errorText: '503 upstream failed', group: true }),
    '上游服务暂时不可用',
  );
});

test('T4.4c uses Chinese compaction completion messages', () => {
  assert.equal(_test.formatCompactionFailureForChat({ status: 'cancelled', group: true }), '已取消上下文压缩，继续使用当前对话');
  assert.match(_test.formatCompactionFailureForChat({ status: 'failed', errorText: 'timeout', group: false }), /^上下文压缩失败，继续使用当前对话/);
});
