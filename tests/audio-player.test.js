import test from 'node:test';
import assert from 'node:assert/strict';
import { PackedAudioPlayer } from '../src/audio-player.js';

class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.src = '';
    this.playbackRate = 1;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
    this.playResult = () => Promise.resolve();
  }
  play() {
    this.playCalls += 1;
    return this.playResult();
  }
  pause() { this.pauseCalls += 1; }
  load() { this.loadCalls += 1; this.playbackRate = 1; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  finish() { this.dispatchEvent(new Event('ended')); }
}

class FakeUrls {
  constructor() {
    this.created = [];
    this.revoked = [];
  }
  createObjectURL(blob) {
    const url = `blob:fake/${this.created.length + 1}`;
    this.created.push({ url, blob });
    return url;
  }
  revokeObjectURL(url) { this.revoked.push(url); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeBook(id = 'book-1', count = 3) {
  return {
    id,
    title: '测试小说',
    paragraphs: Array.from({ length: count }, (_, index) => ({ text: `第${index + 1}段` })),
    audioPack: { voices: [{ id: 'female', name: '女声' }, { id: 'male', name: '男声' }] },
  };
}

function fixture(getAudio = async () => new Blob(['mp3'])) {
  const requests = [];
  const store = {
    getAudio(bookId, index, voiceId) {
      requests.push({ bookId, index, voiceId });
      return getAudio(bookId, index, voiceId);
    },
  };
  const audio = new FakeAudio();
  const urls = new FakeUrls();
  const player = new PackedAudioPlayer({ store, audio, url: urls, mediaSession: null });
  return { player, audio, urls, requests };
}

test('seeking to another paragraph and changing voice load the matching local tracks', async () => {
  const { player, audio, urls, requests } = fixture();
  player.setBook(makeBook());
  await settle();

  player.play();
  assert.equal(audio.src, urls.created[0].url);
  assert.equal(audio.playCalls, 1);

  player.seek(1, { autoplay: true });
  await settle();
  assert.equal(player.index, 1);
  assert.equal(audio.src, urls.created[1].url);
  assert.deepEqual(requests.slice(-1), [{ bookId: 'book-1', index: 1, voiceId: 'female' }]);
  assert.deepEqual(urls.revoked, [urls.created[0].url]);
  assert.equal(audio.playCalls, 2);

  player.setVoice('male');
  await settle();
  assert.equal(player.voiceId, 'male');
  assert.equal(audio.src, urls.created[2].url);
  assert.deepEqual(requests.slice(-1), [{ bookId: 'book-1', index: 1, voiceId: 'male' }]);
  assert.deepEqual(urls.revoked, [urls.created[0].url, urls.created[1].url]);
  assert.equal(audio.playCalls, 3);
});

test('ended advances through paragraphs and ends after the final track', async () => {
  const { player, audio, urls } = fixture();
  player.setBook(makeBook('book-1', 2));
  await settle();
  player.play();
  assert.equal(audio.src, urls.created[0].url);

  audio.finish();
  await settle();
  assert.equal(player.status, 'playing');
  assert.equal(player.index, 1);
  assert.equal(audio.src, urls.created[1].url);
  assert.equal(audio.playCalls, 2);

  audio.finish();
  assert.equal(player.status, 'ended');
  assert.equal(player.index, 1);
});

test('selected rate survives loading the first and following tracks', async () => {
  const { player, audio } = fixture();
  player.setRate(1.5);
  player.setBook(makeBook('book-1', 2));
  await settle();
  assert.equal(audio.playbackRate, 1.5);

  player.play();
  audio.finish();
  await settle();
  assert.equal(audio.playbackRate, 1.5);
});

test('pause invalidates an in-flight read so it cannot start playback later', async () => {
  const read = deferred();
  const { player, audio, urls } = fixture(() => read.promise);
  player.setBook(makeBook());
  player.play();
  player.pause();
  read.resolve(new Blob(['mp3']));
  await settle();

  assert.equal(player.status, 'paused');
  assert.equal(audio.playCalls, 0);
  assert.equal(audio.src, '');
  assert.equal(urls.created.length, 0);

  player.play();
  await settle();
  assert.equal(player.status, 'playing');
  assert.equal(audio.playCalls, 1);
  assert.equal(urls.created.length, 1);
});

test('late audio read for an old paragraph cannot replace the current source', async () => {
  const reads = new Map();
  const { player, audio, urls } = fixture((_bookId, index) => {
    const read = deferred();
    reads.set(index, read);
    return read.promise;
  });
  player.setBook(makeBook());
  player.seek(1);

  reads.get(1).resolve(new Blob(['second']));
  await settle();
  assert.equal(audio.src, urls.created[0].url);

  reads.get(0).resolve(new Blob(['first']));
  await settle();
  assert.equal(player.index, 1);
  assert.equal(audio.src, urls.created[0].url);
  assert.deepEqual(await Promise.all(urls.created.map(item => item.blob.text())), ['second']);
});

test('a rejected media play promise reports denial and ordinary playback errors', async () => {
  const { player, audio } = fixture();
  const errors = [];
  player.addEventListener('statechange', event => {
    if (event.detail.error) errors.push({ status: event.detail.status, error: event.detail.error });
  });
  player.setBook(makeBook('book-1', 1));
  await settle();

  audio.playResult = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  player.play();
  await settle();
  assert.equal(player.status, 'paused');
  assert.match(errors.at(-1).error, /再点一次播放/);

  audio.playResult = () => Promise.reject(new Error('decode failed'));
  player.play();
  await settle();
  assert.equal(player.status, 'error');
  assert.match(errors.at(-1).error, /检查手机声音设置/);
});
