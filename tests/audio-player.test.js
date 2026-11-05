import test from 'node:test';
import assert from 'node:assert/strict';
import { PackedAudioPlayer } from '../src/audio-player.js';
import { NATURAL_VOICES } from '../src/voices.js';
import { OnlineTtsProvider } from '../src/online-tts.js';

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
  await new Promise(resolve => setImmediate(resolve));
}

function makeBook(id = 'book-1', count = 3) {
  return {
    id,
    title: '测试小说',
    paragraphs: Array.from({ length: count }, (_, index) => ({ text: `第${index + 1}段` })),
    audioPack: { voices: [{ id: 'female', name: 'zh-CN-XiaoxiaoNeural' }, { id: 'male', name: 'zh-CN-YunxiNeural' }] },
  };
}

function fixture(getAudio = async () => new Blob(['mp3']), provider) {
  const requests = [];
  const saved = [];
  const store = {
    getAudio(bookId, index, voiceId) {
      requests.push({ bookId, index, voiceId });
      return getAudio(bookId, index, voiceId);
    },
    async putAudioIfBookExists(bookId, index, blob, voiceId) { saved.push({ bookId, index, blob, voiceId }); return true; },
  };
  const audio = new FakeAudio();
  const urls = new FakeUrls();
  const player = new PackedAudioPlayer({ store, provider, audio, url: urls, mediaSession: null });
  return { player, audio, urls, requests, saved, store };
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

test('all four natural voices select their own local tracks at the current paragraph', async () => {
  const { player, audio, requests } = fixture();
  const book = makeBook();
  book.audioPack.voices = NATURAL_VOICES;
  player.setBook(book, 1);
  await settle();
  player.play();
  for (const voice of NATURAL_VOICES) {
    player.setVoice(voice.id);
    await settle();
    assert.equal(player.voiceId, voice.id);
    assert.equal(player.index, 1);
    assert.equal(player.status, 'playing');
    assert.equal(requests.at(-1).voiceId, voice.id);
  }
  const calls = audio.playCalls;
  player.setVoice('en-US');
  assert.equal(player.voiceId, 'yunyang');
  assert.equal(audio.playCalls, calls);
});

test('canonical preferences still play old female and male track keys', async () => {
  const { player, requests } = fixture();
  player.setBook(makeBook());
  await settle();
  player.setVoice('yunxi');
  await settle();
  assert.equal(player.voiceId, 'male');
  assert.equal(requests.at(-1).voiceId, 'male');
  player.setVoice('xiaoyi');
  assert.equal(player.voiceId, 'male');
});

test('ordinary text waits for explicit play and reports an unconfigured online service', async () => {
  const { player, audio, requests } = fixture(async () => null);
  const book = makeBook();
  delete book.audioPack;
  player.setBook(book);
  player.seek(1);
  await settle();
  assert.equal(player.index, 1);
  assert.equal(requests.length, 0);
  let error;
  player.addEventListener('statechange', event => { error = event.detail.error; });
  player.play();
  await settle();
  assert.equal(player.status, 'error');
  assert.match(error, /在线语音服务尚未配置/);
  assert.equal(audio.playCalls, 0);
  assert.equal(requests.length, 1);
});

function ordinaryBook(count = 3) {
  const book = makeBook('ordinary', count);
  delete book.audioPack;
  return book;
}

test('ordinary document opens and paused navigation never generate or upload text', async () => {
  const generated = [];
  const { player, requests } = fixture(async () => null, { generate: async request => { generated.push(request); return new Blob(['audio']); } });
  player.setBook(ordinaryBook());
  player.seek(2, { autoplay: false });
  player.setVoice('yunyang');
  await settle();
  assert.equal(generated.length, 0);
  assert.equal(requests.length, 0);
  assert.equal(player.index, 2);
  assert.equal(player.voiceId, 'yunyang');
});

test('ordinary document generates the selected exact voice, caches it, and advances', async () => {
  const generated = [];
  const { player, audio, saved } = fixture(async () => null, { generate: async request => { generated.push(request); return new Blob([request.text], { type: 'audio/mpeg' }); } });
  player.setBook(ordinaryBook(2));
  player.setVoice('xiaoyi');
  player.play();
  assert.equal(player.status, 'loading');
  await settle();
  assert.equal(player.status, 'playing');
  assert.equal(audio.playCalls, 1);
  assert.equal(generated[0].voiceId, 'xiaoyi');
  assert.equal(generated[0].text, '第1段');
  assert.equal(saved[0].voiceId, 'xiaoyi');
  audio.finish();
  await settle();
  assert.equal(generated[1].text, '第2段');
  assert.equal(player.status, 'playing');
  assert.equal(saved.length, 2);
});

test('cached online audio plays offline without consulting the provider', async () => {
  let generated = 0;
  const { player, audio } = fixture(async () => new Blob(['cached']), { generate() { generated++; throw new Error('offline'); } });
  player.setBook(ordinaryBook());
  player.setVoice('yunxi');
  player.play();
  await settle();
  assert.equal(player.status, 'playing');
  assert.equal(audio.playCalls, 1);
  assert.equal(generated, 0);
});

test('ordinary document permits only the four canonical voices', async () => {
  const generated = [];
  const { player } = fixture(async () => null, { generate: async request => { generated.push(request.voiceId); return new Blob(['audio']); } });
  player.setBook(ordinaryBook());
  for (const voice of NATURAL_VOICES) {
    player.setVoice(voice.id);
    player.play();
    await settle();
    player.pause();
  }
  assert.deepEqual(generated, NATURAL_VOICES.map(voice => voice.id));
  player.setVoice('en-US');
  assert.equal(player.voiceId, 'yunyang');
});

test('pause cancels online generation and a late result cannot play or be cached', async () => {
  const generation = deferred();
  let request;
  const { player, audio, saved, urls } = fixture(async () => null, { generate(value) { request = value; return generation.promise; } });
  player.setBook(ordinaryBook());
  player.play();
  await settle();
  assert.equal(player.status, 'loading');
  player.toggle();
  assert.equal(request.signal.aborted, true);
  generation.resolve(new Blob(['late']));
  await settle();
  assert.equal(player.status, 'paused');
  assert.equal(audio.playCalls, 0);
  assert.equal(saved.length, 0);
  assert.equal(urls.created.length, 0);
});

test('changing voice cancels old generation and only the new voice can play', async () => {
  const requests = [];
  const { player, saved, urls } = fixture(async () => null, { generate(value) { const pending = deferred(); requests.push({ ...value, ...pending }); return pending.promise; } });
  player.setBook(ordinaryBook());
  player.play();
  await settle();
  player.setVoice('yunyang');
  await settle();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(new Blob(['new']));
  await settle();
  requests[0].resolve(new Blob(['old']));
  await settle();
  assert.equal(player.voiceId, 'yunyang');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].voiceId, 'yunyang');
  assert.equal(await urls.created[0].blob.text(), 'new');
});

test('deleting or changing the book discards in-flight speech and atomic cache rejects removed books', async () => {
  const generation = deferred();
  const f = fixture(async () => null, { generate: () => generation.promise });
  f.player.setBook(ordinaryBook());
  f.player.play();
  await settle();
  f.player.setBook(null);
  generation.resolve(new Blob(['late']));
  await settle();
  assert.equal(f.saved.length, 0);
  assert.equal(f.audio.playCalls, 0);

  f.player.provider = { generate: async () => new Blob(['removed']) };
  f.store.putAudioIfBookExists = async () => false;
  f.player.setBook(ordinaryBook());
  let error;
  f.player.addEventListener('statechange', event => { if (event.detail.error) error = event.detail.error; });
  f.player.play();
  await settle();
  assert.equal(f.player.status, 'error');
  assert.match(error, /已被移除/);
  assert.equal(f.audio.playCalls, 0);
});

test('online network failure is retryable and never falls back to package instructions', async () => {
  let attempts = 0;
  const { player, audio } = fixture(async () => null, { generate: async () => { if (++attempts === 1) throw new Error('网络连接失败，请重试。'); return new Blob(['retried']); } });
  player.setBook(ordinaryBook());
  let error;
  player.addEventListener('statechange', event => { if (event.detail.error) error = event.detail.error; });
  player.play();
  await settle();
  assert.equal(player.status, 'error');
  assert.match(error, /网络/);
  assert.doesNotMatch(error, /听书包/);
  player.play();
  await settle();
  assert.equal(player.status, 'playing');
  assert.equal(audio.playCalls, 1);
});

test('revoked online consent does not prevent cached ordinary audio playback', async () => {
  let networkCalls = 0;
  const provider = new OnlineTtsProvider({
    endpoint: 'https://voice.example/v1/tts', canGenerate: () => false,
    fetch: async () => { networkCalls++; throw new Error('must not upload'); },
  });
  const { player, audio } = fixture(async () => new Blob(['cached']), provider);
  player.setBook(ordinaryBook());
  player.play();
  await settle();
  assert.equal(player.status, 'playing');
  assert.equal(audio.playCalls, 1);
  assert.equal(networkCalls, 0);
});

test('a cache miss that needs consent pauses without a playback error and retries after consent', async () => {
  let allowed = false, networkCalls = 0;
  const provider = new OnlineTtsProvider({
    endpoint: 'https://voice.example/v1/tts', canGenerate: () => allowed,
    fetch: async () => { networkCalls++; return new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } }); },
  });
  const { player, audio } = fixture(async () => null, provider);
  const errors = [];
  player.addEventListener('statechange', event => { if (event.detail.error) errors.push(event.detail.error); });
  player.setBook(ordinaryBook());
  player.play();
  await settle();
  assert.equal(player.status, 'paused');
  assert.equal(audio.playCalls, 0);
  assert.equal(networkCalls, 0);
  assert.deepEqual(errors, []);
  allowed = true;
  player.play();
  await settle();
  assert.equal(player.status, 'playing');
  assert.equal(networkCalls, 1);
  assert.equal(audio.playCalls, 1);
});

test('ordinary books can generate temporary audio when the local cache is unavailable', async () => {
  let generated = 0;
  const { player, audio, saved } = fixture(async () => { throw new Error('IndexedDB unavailable'); }, {
    generate: async () => { generated++; return new Blob(['temporary']); },
  });
  const warnings = [];
  player.addEventListener('cachewarning', event => warnings.push(event.detail.message));
  player.setBook(ordinaryBook());
  player.play();
  await settle();
  assert.equal(player.status, 'playing');
  assert.equal(generated, 1);
  assert.equal(audio.playCalls, 1);
  assert.equal(saved.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /暂不保存/);
});

test('package cache failures stay local and cannot upload the book for regeneration', async () => {
  let generated = 0;
  const { player, audio } = fixture(async () => { throw new Error('local audio unavailable'); }, {
    generate: async () => { generated++; return new Blob(['must not generate']); },
  });
  player.setBook(makeBook());
  await settle();
  player.play();
  await settle();
  assert.equal(player.status, 'error');
  assert.equal(audio.playCalls, 0);
  assert.equal(generated, 0);
});

test('a cache failure arriving after pause cannot upload text or show a stale warning', async () => {
  const read = deferred();
  let generated = 0, warnings = 0;
  const { player, audio } = fixture(() => read.promise, {
    generate: async () => { generated++; return new Blob(['must not generate']); },
  });
  player.addEventListener('cachewarning', () => warnings++);
  player.setBook(ordinaryBook());
  player.play();
  player.pause();
  read.reject(new Error('late cache failure'));
  await settle();
  assert.equal(player.status, 'paused');
  assert.equal(generated, 0);
  assert.equal(audio.playCalls, 0);
  assert.equal(warnings, 0);
});
