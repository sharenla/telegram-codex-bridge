const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../index');

test('TelegramApi keeps bot token out of curl argv and sends URL through config stdin', async () => {
  let captured = null;
  const api = new _test.TelegramApi('123456:SECRET_TOKEN', {
    execFileFn: (command, args, options, callback) => {
      captured = { command, args: [...args], options, config: '' };
      const child = {
        stdin: {
          write(value) { captured.config += String(value); },
          end() {},
        },
        once() {},
      };
      process.nextTick(() => callback(null, JSON.stringify({ ok: true, result: { id: 1 } }), ''));
      return child;
    },
  });
  const result = await api.callOnce('getMe', {});
  assert.deepEqual(result, { id: 1 });
  assert.equal(captured.command, 'curl');
  assert.deepEqual(captured.args.slice(-2), ['--config', '-']);
  assert.doesNotMatch(captured.args.join(' '), /api\.telegram\.org\/bot\d+:/);
  assert.doesNotMatch(captured.args.join(' '), /SECRET_TOKEN/);
  assert.match(captured.config, /url = "https:\/\/api\.telegram\.org\/bot123456:SECRET_TOKEN\/getMe"/);
  assert.match(captured.config, /url =/);
});

test('curl config values escape quotes, backslashes, and newlines', () => {
  assert.equal(_test.quoteCurlConfigValue('a"b\\c\n'), 'a\\"b\\\\c\\n');
});
