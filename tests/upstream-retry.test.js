const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../index.js');

test('classifies structured upstream 503 and stream failures as upstream_transient', () => {
  assert.equal(_test.classifyUpstreamTransientError({ error: { status: 503 } }), true);
  assert.equal(_test.classifyUpstreamTransientError({ error: { codexErrorInfo: 'stream disconnected' } }), true);
  assert.equal(_test.classifyUpstreamTransientError({ error: { message: 'Hard affinity owner account is unavailable' } }), true);
  assert.equal(_test.classifyUpstreamTransientError({ error: { message: 'No available accounts' } }), true);
  assert.equal(_test.classifyUpstreamTransientError({ error: { message: 'proxy rejected connection' } }), true);
  assert.equal(_test.classifyUpstreamTransientError({ error: { message: 'Codex upstream stream failed' } }), true);
  assert.equal(_test.classifyUpstreamTransientError({ error: { codexErrorInfo: 'upstream_5xx' } }), true);
  assert.equal(_test.classifyUpstreamTransientError({ error: { codexErrorInfo: { statusCode: 502 } } }), true);
});

test('structured non-5xx status wins over incidental 503 text', () => {
  assert.equal(_test.classifyUpstreamTransientError({ error: { status: 400, message: 'request mentioned 503' } }), false);
});

test('turn with no tool activity retries on same account and succeeds without a fourth attempt', async () => {
  const starts = [];
  const result = await _test.retryUpstreamTurn({
    turn: { error: { status: 503 } },
    retryCount: 0,
    toolActivity: false,
    maxRetries: _test.MAX_UPSTREAM_RETRIES,
    sleep: async () => {},
    onRetry: async count => starts.push(count),
  });
  assert.equal(result.retry, true);
  assert.equal(result.errorClass, _test.UPSTREAM_TRANSIENT_ERROR_CLASS);
  assert.deepEqual(starts, [1]);
  const exhausted = await _test.retryUpstreamTurn({
    turn: { error: { status: 503 } },
    retryCount: _test.MAX_UPSTREAM_RETRIES,
    toolActivity: false,
    maxRetries: _test.MAX_UPSTREAM_RETRIES,
    sleep: async () => {},
    onRetry: async count => starts.push(count),
  });
  assert.equal(exhausted.exhausted, true);
  assert.deepEqual(starts, [1]);
});

test('turn with commandExecution activity never retries and reports partial execution', async () => {
  let calls = 0;
  const result = await _test.retryUpstreamTurn({
    turn: { error: { message: 'websocket closed before response.completed' } },
    retryCount: 0,
    toolActivity: true,
    sleep: async () => {},
    onRetry: async () => { calls += 1; },
  });
  assert.equal(result.retry, false);
  assert.equal(result.partialExecution, true);
  assert.equal(calls, 0);
});

test('upstream retry policy does not trigger account failover', () => {
  assert.equal(_test.isAccountFailoverText('503 upstream unavailable'), false);
});

test('group failure text is Chinese and contains no raw URL or upstream English', () => {
  const text = _test.formatUpstreamFailureForChat({
    requestId: 'a1b2',
    partialExecution: true,
    group: true,
  });
  assert.match(text, /上游中断/);
  assert.doesNotMatch(text, /https?:\/\//i);
  assert.doesNotMatch(text, /websocket|Codex|503/i);
});
