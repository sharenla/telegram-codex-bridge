const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../index.js');

test('structured server_overloaded is classified as model busy', () => {
  assert.equal(_test.classifyServerOverloadedError({ error: { codexErrorInfo: 'server_overloaded' } }), true);
});

test('capacity text is classified as model busy when no structured code exists', () => {
  assert.equal(_test.classifyServerOverloadedError({ error: { message: 'Selected model is at capacity' } }), true);
});

test('structured non-overloaded code wins over incidental capacity text', () => {
  assert.equal(_test.classifyServerOverloadedError({ error: { codexErrorInfo: 'usageLimitExceeded', message: 'Selected model is at capacity' } }), false);
});

test('model busy retries on the same account for structured and capacity errors', async () => {
  for (const turn of [
    { error: { codexErrorInfo: 'server_overloaded' } },
    { error: { message: 'Selected model is at capacity' } },
  ]) {
    let retries = 0;
    const result = await _test.retryClassifiedTurn({
      turn,
      classifier: _test.classifyServerOverloadedError,
      errorClass: 'server_overloaded',
      maxRetries: 2,
      sleep: async () => {},
      onRetry: async () => { retries += 1; },
    });
    assert.equal(result.retry, true);
    assert.equal(result.nextRetryCount, 1);
    assert.equal(retries, 1);
  }
});

test('real account failures still trigger account failover', () => {
  assert.equal(_test.isAccountFailoverText('usageLimitExceeded'), true);
  assert.equal(_test.isAccountFailoverText('429 Too Many Requests'), true);
  assert.equal(_test.isAccountFailoverText('quota exceeded'), true);
  assert.equal(_test.isAccountFailoverText('Selected model is at capacity'), false);
  assert.equal(_test.isAccountFailoverText('server_overloaded'), false);
});

test('model busy with tool activity never retries and reports partial execution', async () => {
  const result = await _test.retryClassifiedTurn({
    turn: { error: { codexErrorInfo: 'server_overloaded' } },
    classifier: _test.classifyServerOverloadedError,
    errorClass: 'server_overloaded',
    toolActivity: true,
    maxRetries: 2,
    sleep: async () => {},
    onRetry: async () => { throw new Error('must not retry'); },
  });
  assert.equal(result.retry, false);
  assert.equal(result.partialExecution, true);
});

test('model busy exhaustion suggests changing model without mutating session', async () => {
  const session = { model: 'gpt-5.4' };
  const result = await _test.retryClassifiedTurn({
    turn: { error: { codexErrorInfo: 'server_overloaded' } },
    retryCount: 2,
    classifier: _test.classifyServerOverloadedError,
    errorClass: 'server_overloaded',
    maxRetries: 2,
    sleep: async () => {},
    onRetry: async () => {},
  });
  assert.equal(result.exhausted, true);
  assert.equal(session.model, 'gpt-5.4');
  const text = _test.formatModelBusyForChat({ requestId: 'a1b2', retryCount: 2 });
  assert.match(text, /当前模型繁忙/);
  assert.match(text, /已重试 2 次/);
  assert.match(text, /\/model/);
});
