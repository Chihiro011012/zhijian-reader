import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, SpeechPlayer } from '../src/speech.js';

class FakeUtterance { constructor(text) { this.text = text; } }
class FakeSynthesis extends EventTarget {
  constructor() {
    super();
    this.spoken = [];
    this.cancelCount = 0;
    this.voices = [
      { name: 'English', lang: 'en-US', voiceURI: 'en' },
      { name: '中文声音', lang: 'zh-CN', voiceURI: 'zh' },
    ];
  }
  getVoices() { return this.voices; }
  cancel() { this.cancelCount += 1; }
  speak(utterance) { this.spoken.push(utterance); }
  get current() { return this.spoken.at(-1); }
  finish() { this.current.onend(); }
}

function fixture(paragraphs = ['第一段。', '第二段。']) {
  const synthesis = new FakeSynthesis();
  const player = new SpeechPlayer({ synthesis, Utterance: FakeUtterance });
  player.setBook(paragraphs.map((text) => ({ text, type: 'paragraph' })));
  return { player, synthesis };
}

test('chunks bound long Chinese text without breaking surrogate pairs or losing content', () => {
  const text = `${'雨落在窗前，'.repeat(25)}夜色温柔。${'😀'.repeat(200)}`;
  const chunks = chunkText(text);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 180));
  assert.ok(chunks.every((chunk) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk)));
});

test('preserves spaces between English words when splitting on word boundaries', () => {
  const text = 'A sentence with ordinary spaces. '.repeat(30).trim();
  const chunks = chunkText(text, 32);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
});

test('starts synchronously, prefers a Chinese voice, and advances through paragraphs', () => {
  const { player, synthesis } = fixture();
  const positions = [];
  player.addEventListener('positionchange', (event) => positions.push(event.detail.index));
  player.play();
  assert.equal(player.status, 'playing');
  assert.equal(synthesis.current.text, '第一段。');
  assert.equal(synthesis.current.voice.voiceURI, 'zh');
  synthesis.finish();
  assert.equal(player.index, 1);
  assert.equal(synthesis.current.text, '第二段。');
  synthesis.finish();
  assert.equal(player.status, 'ended');
  assert.equal(player.index, 1);
  assert.deepEqual(positions, [1]);
});

test('pause replays the current chunk while ignoring canceled utterance callbacks', () => {
  const { player, synthesis } = fixture(['句子。'.repeat(100), '下一段。']);
  player.play();
  synthesis.finish();
  const canceled = synthesis.current;
  const chunkText = canceled.text;
  player.pause();
  assert.equal(player.status, 'paused');
  canceled.onend();
  canceled.onerror({ error: 'canceled' });
  assert.equal(player.status, 'paused');
  assert.equal(player.index, 0);
  player.play();
  assert.equal(synthesis.current.text, chunkText);
  assert.notEqual(synthesis.current, canceled);
});

test('seeking invalidates stale callbacks and honors explicit autoplay', () => {
  const { player, synthesis } = fixture();
  player.play();
  const stale = synthesis.current;
  player.seek(1);
  assert.equal(player.index, 1);
  assert.equal(synthesis.current.text, '第二段。');
  const spokenCount = synthesis.spoken.length;
  stale.onend();
  assert.equal(synthesis.spoken.length, spokenCount);
  player.seek(-50, { autoplay: false });
  assert.equal(player.index, 0);
  assert.equal(player.status, 'paused');
  player.seek(500, { autoplay: true });
  assert.equal(player.index, 1);
  assert.equal(player.status, 'playing');
});

test('rate and voice changes restart the same chunk using new settings', () => {
  const { player, synthesis } = fixture();
  player.play();
  const original = synthesis.current;
  player.setRate(1.5);
  assert.equal(synthesis.current.rate, 1.5);
  assert.equal(synthesis.current.text, original.text);
  player.setRate(99);
  assert.equal(synthesis.current.rate, 2);
  player.setVoice('en');
  assert.equal(synthesis.current.voice.voiceURI, 'en');
  original.onend();
  assert.equal(player.index, 0);
});

test('errors surface actionable Chinese messages and unsupported speech remains usable', () => {
  const { player, synthesis } = fixture();
  let error;
  player.addEventListener('statechange', (event) => { error = event.detail.error; });
  player.play();
  synthesis.current.onerror({ error: 'not-allowed' });
  assert.equal(player.status, 'error');
  assert.match(error, /播放/);
  const unsupported = new SpeechPlayer({ synthesis: null, Utterance: null });
  unsupported.setBook([{ text: '仍可阅读。' }]);
  assert.equal(unsupported.supported, false);
  unsupported.play();
  assert.equal(unsupported.status, 'error');
});

test('voice list updates after asynchronous system loading and destroy removes listeners', () => {
  const { player, synthesis } = fixture();
  let changes = 0;
  player.addEventListener('voiceschange', () => { changes += 1; });
  synthesis.voices.push({ name: '中文声音二', lang: 'zh-TW', voiceURI: 'zh2' });
  synthesis.dispatchEvent(new Event('voiceschanged'));
  assert.equal(changes, 1);
  assert.equal(player.voices.length, 3);
  player.destroy();
  synthesis.dispatchEvent(new Event('voiceschanged'));
  assert.equal(changes, 1);
});

test('empty paragraphs are skipped and replay after completion starts at the beginning', () => {
  const { player, synthesis } = fixture(['', '内容。', '']);
  player.play();
  assert.equal(player.index, 1);
  assert.equal(synthesis.current.text, '内容。');
  synthesis.finish();
  assert.equal(player.status, 'ended');
  player.play();
  assert.equal(player.index, 1);
  assert.equal(player.status, 'playing');
});
