import test from 'node:test';
import assert from 'node:assert/strict';
import { ReaderPlayer } from '../src/reader-player.js';
import { SpeechPlayer } from '../src/speech.js';

class FakeUtterance { constructor(text) { this.text = text; this.voice = null; this.lang = ''; } }
class FakeSynthesis extends EventTarget {
  constructor() { super(); this.spoken = []; this.cancelCount = 0; }
  getVoices() { throw new Error('System voice lists must never be requested.'); }
  cancel() { this.cancelCount++; }
  speak(utterance) { this.spoken.push(utterance); }
  get current() { return this.spoken.at(-1); }
}
class FakeAudioPlayer extends EventTarget {
  constructor() { super(); this.status = 'idle'; this.index = 0; this.supported = true; this.bookCalls = 0; this.playCalls = 0; this.stopCalls = 0; }
  setBook(book, index = 0) { this.bookCalls++; this.book = book; this.index = index; this.status = 'idle'; }
  setVoice(voice) { this.voiceId = voice; }
  setRate(rate) { this.rate = rate; }
  play() { this.playCalls++; this.status = 'playing'; this.emit('statechange', { status: this.status, index: this.index }); }
  pause() { this.status = 'paused'; this.emit('statechange', { status: this.status, index: this.index }); }
  stop() { this.stopCalls++; this.status = 'idle'; this.emit('statechange', { status: this.status, index: this.index }); }
  seek(index, { autoplay } = {}) { this.index = index; this.emit('positionchange', { index }); if (autoplay) this.play(); }
  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
}
const book = { id: 'one', title: '测试', paragraphs: [{ text: '第一段。' }, { text: '第二段。' }] };
function fixture() {
  const synthesis = new FakeSynthesis();
  const speechPlayer = new SpeechPlayer({ synthesis, Utterance: FakeUtterance, defaultVoiceOnly: true });
  const audioPlayer = new FakeAudioPlayer();
  const player = new ReaderPlayer({ speechPlayer, audioPlayer, mediaSession: null });
  return { player, synthesis, audioPlayer };
}

test('system selection reads text synchronously without initializing audio or choosing a named voice', () => {
  const { player, synthesis, audioPlayer } = fixture();
  player.setBook(book, 0, 'system');
  assert.equal(audioPlayer.bookCalls, 0);
  assert.equal(player.systemSupported, true);
  player.play();
  assert.equal(synthesis.current.text, '第一段。');
  assert.equal(synthesis.current.voice, null);
  assert.equal(synthesis.current.lang, '');
  assert.equal(audioPlayer.playCalls, 0);
  assert.equal(player.status, 'playing');
  synthesis.current.onend();
  assert.equal(player.index, 1);
  synthesis.current.onend();
  assert.equal(player.status, 'ended');
});

test('switching from online audio cancels it, preserves position and rate, and ignores its late events', () => {
  const { player, synthesis, audioPlayer } = fixture();
  const positions = [];
  player.addEventListener('positionchange', event => positions.push(event.detail.index));
  player.setRate(1.4);
  player.setBook(book, 1, 'xiaoxiao');
  player.play();
  const stopped = audioPlayer.stopCalls;
  player.setVoice('system');
  assert.ok(audioPlayer.stopCalls > stopped);
  assert.equal(player.index, 1);
  assert.equal(synthesis.current.text, '第二段。');
  assert.equal(synthesis.current.rate, 1.4);
  audioPlayer.emit('positionchange', { index: 0 });
  audioPlayer.emit('statechange', { status: 'error', error: 'old online request' });
  assert.equal(player.status, 'playing');
  assert.deepEqual(positions, [1]);
  player.pause();
  assert.equal(player.status, 'paused');
});

test('switching back to audio suppresses canceled speech and keeps later books in system mode', () => {
  const { player, synthesis, audioPlayer } = fixture();
  player.setBook(book, 1, 'system');
  player.play();
  const stale = synthesis.current;
  player.setVoice('yunxi');
  assert.equal(audioPlayer.voiceId, 'yunxi');
  assert.equal(player.index, 1);
  assert.equal(player.status, 'playing');
  stale.onend();
  stale.onerror({ error: 'canceled' });
  assert.equal(player.index, 1);
  assert.equal(player.status, 'playing');
  player.setVoice('system');
  player.setBook({ ...book, id: 'two' }, 0);
  assert.equal(player.voiceId, 'system');
  assert.equal(player.index, 0);
  assert.equal(player.status, 'idle');
});

test('a packaged book can use system speech and retains only available recorded voices', () => {
  const { player, synthesis, audioPlayer } = fixture();
  const packed = { ...book, audioPack: { voices: [{ id: 'female', name: 'zh-CN-XiaoxiaoNeural' }] } };
  player.setBook(packed, 0, 'yunxi');
  assert.equal(player.voiceId, 'xiaoxiao');
  player.setVoice('yunxi');
  assert.equal(player.voiceId, 'xiaoxiao');
  player.setVoice('system');
  player.play();
  assert.equal(synthesis.current.text, '第一段。');
  player.setVoice('female');
  assert.equal(player.voiceId, 'xiaoxiao');
  assert.equal(audioPlayer.playCalls, 1);
});

test('media controls operate the selected player after a switch', () => {
  const { player, synthesis } = fixture();
  const handlers = new Map();
  player.mediaSession = { setActionHandler: (name, handler) => handlers.set(name, handler) };
  player._installMediaSession();
  player.setBook(book, 0, 'system');
  handlers.get('play')();
  assert.equal(player.mediaSession.playbackState, 'playing');
  handlers.get('nexttrack')();
  assert.equal(synthesis.current.text, '第二段。');
  handlers.get('pause')();
  assert.equal(player.status, 'paused');
  assert.equal(player.mediaSession.playbackState, 'paused');
});
