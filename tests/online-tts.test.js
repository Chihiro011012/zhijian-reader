import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineTtsProvider, splitSpeechText, validTtsEndpoint, MAX_TTS_CHARS } from '../src/online-tts.js';
import { NATURAL_VOICES } from '../src/voices.js';

const endpoint = 'https://voice.example/v1/tts';
const response = text => new Response(text, { headers: { 'Content-Type': 'audio/mpeg' } });

test('default browser fetch keeps its global receiver', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = function () {
    assert.equal(this, globalThis);
    return Promise.resolve(response('mp3'));
  };
  try {
    const provider = new OnlineTtsProvider({ endpoint });
    assert.equal(await (await provider.generate({ text: '中性测试。', voiceId: 'xiaoxiao' })).text(), 'mp3');
  } finally { globalThis.fetch = previousFetch; }
});

test('long text splits without losing punctuation, spaces, or supplementary characters', () => {
  const text = `${'甲'.repeat(1400)}。\n ${'乙😀'.repeat(2300)}！结束。`;
  const chunks = splitSpeechText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= MAX_TTS_CHARS));
  assert.equal(chunks[0], `${'甲'.repeat(1400)}。\n`);
  assert.ok(!chunks.some(chunk => /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(chunk)));
});

test('provider posts exact four canonical voice IDs and never enumerates system voices', async () => {
  const requests = [];
  const provider = new OnlineTtsProvider({ endpoint, fetch: async (url, init) => { requests.push({ url, ...init }); return response('mp3'); } });
  for (const voice of NATURAL_VOICES) {
    const blob = await provider.generate({ text: '今天阳光很好。', voiceId: voice.id });
    assert.equal(blob.type, 'audio/mpeg');
    assert.equal(await blob.text(), 'mp3');
  }
  assert.deepEqual(requests.map(request => JSON.parse(request.body).voice), NATURAL_VOICES.map(voice => voice.id));
  assert.ok(requests.every(request => request.url === endpoint && request.method === 'POST' && request.credentials === 'omit' && request.cache === 'no-store'));
});

test('long paragraphs generate every chunk in order and combine complete audio', async () => {
  const texts = [];
  const text = '春天。'.repeat(1800);
  const provider = new OnlineTtsProvider({ endpoint, fetch: async (_url, init) => { const part = JSON.parse(init.body).text; texts.push(part); return response(String(texts.length)); } });
  const blob = await provider.generate({ text, voiceId: 'xiaoxiao' });
  assert.equal(texts.join(''), text);
  assert.ok(texts.every(part => Array.from(part).length <= 800));
  assert.equal(await blob.text(), texts.map((_, i) => i + 1).join(''));
});

test('no consent, invalid voice, and missing service never send text', async () => {
  let calls = 0;
  const provider = new OnlineTtsProvider({ endpoint, canGenerate: () => false, fetch: async () => { calls++; return response('mp3'); } });
  await assert.rejects(provider.generate({ text: '中性测试。', voiceId: 'xiaoxiao' }), /请先同意/);
  await assert.rejects(provider.generate({ text: '中性测试。', voiceId: 'en-US' }), /请选择/);
  provider.endpoint = '';
  await assert.rejects(provider.generate({ text: '中性测试。', voiceId: 'xiaoxiao' }), /尚未配置/);
  assert.equal(calls, 0);
});

test('service URLs require HTTPS except loopback and disallow embedded credentials', () => {
  assert.equal(validTtsEndpoint(endpoint), true);
  assert.equal(validTtsEndpoint('http://localhost:8787/v1/tts'), true);
  for (const url of ['http://voice.example/v1/tts', 'https://user:password@voice.example/', 'javascript:alert(1)', '', 'https://voice.example/#secret']) assert.equal(validTtsEndpoint(url), false);
});

test('abort during an earlier chunk prevents all following requests', async () => {
  const controller = new AbortController();
  let requests = 0;
  const provider = new OnlineTtsProvider({ endpoint, fetch: async () => { requests++; controller.abort(); return response('mp3'); } });
  await assert.rejects(provider.generate({ text: '甲'.repeat(5000), voiceId: 'yunxi', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('network, rate limit, timeout, and nonaudio responses produce useful retry errors', async () => {
  for (const [fetch, pattern] of [
    [async () => { throw new TypeError('Failed to fetch'); }, /无法连接/],
    [async () => new Response('', { status: 429 }), /繁忙/],
    [async () => new Response('', { status: 504 }), /暂时不可用/],
    [async () => new Response('<html>error</html>'), /格式不正确/],
  ]) {
    const provider = new OnlineTtsProvider({ endpoint, fetch });
    await assert.rejects(provider.generate({ text: '中性测试。', voiceId: 'yunyang' }), pattern);
  }
  const provider = new OnlineTtsProvider({ endpoint, timeoutMs: 5, fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
  await assert.rejects(provider.generate({ text: '中性测试。', voiceId: 'yunyang' }), /超时/);
});

test('an endpoint change cannot silently redirect later chunks of an active request', async () => {
  const urls = [];
  const agreed = [];
  const provider = new OnlineTtsProvider({ endpoint, canGenerate: url => { agreed.push(url); return true; }, fetch: async url => { urls.push(url); provider.endpoint = 'https://other.example/v1/tts'; return response('mp3'); } });
  await provider.generate({ text: '甲'.repeat(5000), voiceId: 'xiaoxiao' });
  assert.deepEqual(urls, Array(7).fill(endpoint));
  assert.deepEqual(agreed, urls);
});

test('oversized audio is rejected before buffering an excessive response', async () => {
  const provider = new OnlineTtsProvider({ endpoint, fetch: async () => new Response('mp3', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(17 * 1024 * 1024) } }) });
  await assert.rejects(provider.generate({ text: '中性测试。', voiceId: 'xiaoyi' }), /音频过大/);
});
