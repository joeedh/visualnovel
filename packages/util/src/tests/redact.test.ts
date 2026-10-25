import { redactSecrets } from '../redact.js';

it('removes keys from URLs, headers and bare key shapes', () => {
  expect(
    redactSecrets('POST https://g.test/v1beta/x:generate?alt=sse&key=AIzaSyA1b2c3 failed'),
  ).toBe('POST https://g.test/v1beta/x:generate?alt=sse&key=<redacted> failed');
  expect(redactSecrets('{"x-api-key": "abc123", "accept": "json"}')).toBe(
    '{"x-api-key": "<redacted>", "accept": "json"}',
  );
  expect(redactSecrets('Authorization: Bearer sk-or-v1-abcdef0123')).toBe(
    'Authorization: <redacted>',
  );
  expect(redactSecrets('used sk-ant-api03-abcdefghijkl by mistake')).toBe(
    'used <redacted> by mistake',
  );
});

it('leaves ordinary text alone and is idempotent', () => {
  const text = 'Claude request failed (claude-opus-5-5): 529 overloaded';
  expect(redactSecrets(text)).toBe(text);
  const once = redactSecrets('?key=AIzaSECRET');
  expect(redactSecrets(once)).toBe(once);
});
