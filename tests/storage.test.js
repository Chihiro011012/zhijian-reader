import test from 'node:test';
import assert from 'node:assert/strict';
import { BookStore, DEFAULT_SETTINGS, normalizeSettings, readSettings, writeSettings } from '../src/storage.js';
import { NATURAL_VOICES } from '../src/voices.js';

function withLocalStorage(value, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  try { callback(); } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
}

test('preferences use defaults for missing or malformed saved data', () => {
  for (const value of [null, '{bad json', 'null', '[]', '"fontSize"']) {
    withLocalStorage({ getItem: () => value }, () => assert.deepEqual(readSettings(), DEFAULT_SETTINGS));
  }
});

test('preferences validate bounds, types, and the supported choices', () => {
  assert.deepEqual(normalizeSettings({
    fontSize: 99, rate: -3, lineHeight: 99, fontFamily: 'custom', theme: 'unknown', voiceURI: 3, sleepMinutes: 999,
  }), { ...DEFAULT_SETTINGS, fontSize: 32, rate: 0.5, lineHeight: 2.4 });
  assert.deepEqual(normalizeSettings({ fontSize: '28', rate: NaN, lineHeight: Infinity }), DEFAULT_SETTINGS);
  assert.equal(normalizeSettings({ fontSize: 10 }).fontSize, 16);
  assert.equal(normalizeSettings({ rate: 5 }).rate, 2);
  assert.equal(normalizeSettings({ lineHeight: 0 }).lineHeight, 1.6);
  assert.equal(normalizeSettings({ audioVoiceId: 'male' }).audioVoiceId, 'yunxi');
  assert.equal(normalizeSettings({ audioVoiceId: 'female' }).audioVoiceId, 'xiaoxiao');
  assert.equal(normalizeSettings({ audioVoiceId: 'robot' }).audioVoiceId, 'xiaoxiao');
  for (const voice of NATURAL_VOICES) assert.equal(normalizeSettings({ audioVoiceId: voice.id }).audioVoiceId, voice.id);
});

test('save and reload user settings without persisting novel text or arbitrary data', () => {
  const values = new Map();
  const source = {
    fontSize: 26, fontFamily: 'sans', theme: 'dark', lineHeight: 2.2,
    rate: 1.25, voiceURI: 'com.apple.voice.zh-CN.Tingting', sleepMinutes: 30,
    books: [{ text: 'Private manuscript' }], unknown: true,
  };
  withLocalStorage({ getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, () => {
    const saved = writeSettings(source);
    assert.deepEqual(readSettings(), saved);
    assert.equal(saved.voiceURI, undefined);
    assert.equal(saved.books, undefined);
    assert.equal(values.size, 1);
    assert.equal(values.keys().next().value, 'zhijian-settings-v1');
    assert.ok(!values.values().next().value.includes('Private manuscript'));
    assert.ok(!values.values().next().value.includes('com.apple.voice'));
    assert.equal(source.unknown, true);
  });
});

test('restricted storage does not prevent using preferences in the current session', () => {
  withLocalStorage({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } }, () => {
    assert.deepEqual(readSettings(), DEFAULT_SETTINGS);
    assert.equal(writeSettings({ rate: 1.5 }).rate, 1.5);
  });
});

test('unavailable IndexedDB gives a useful error and never saves books in localStorage', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try {
    await assert.rejects(new BookStore().put({ id: 'private', paragraphs: [{ text: 'Private manuscript' }] }), /Safari|本地书籍/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else delete globalThis.indexedDB;
  }
});

test('audio storage supports the four voices while preserving legacy track keys', async () => {
  const store = new BookStore();
  const records = new Map();
  store.audioTransaction = async (_mode, operation) => operation({
    put(record) { records.set(record.key, record); },
    get(key) { return records.get(key); },
  });
  for (const id of [...NATURAL_VOICES.map(voice => voice.id), 'female', 'male']) {
    const blob = new Blob([id], { type: 'audio/mpeg' });
    await store.putAudio('book', 0, blob, id);
    assert.equal(await (await store.getAudio('book', 0, id)).text(), id);
    assert.ok(records.has(`book:${id}:0`));
  }
  assert.equal(records.size, 6);
  await assert.rejects(store.putAudio('book', 0, new Blob(['bad']), 'unapproved'), /音频片段数据无效/);
  assert.equal(await store.getAudio('book', 0, 'unapproved'), null);
});

test('a four-voice audio pack is stored together with every matching track', async () => {
  const store = new BookStore();
  const writes = [];
  store.init = async () => store;
  store.replaceAudioPack = (_audio, bookId, tracks) => writes.push({ bookId, tracks });
  store.db = { transaction() {
    const transaction = { objectStore: () => ({ put: book => writes.push(book) }) };
    queueMicrotask(() => transaction.oncomplete());
    return transaction;
  } };
  const book = { id: 'book', paragraphs: [{ text: '正文' }], audioPack: { voices: NATURAL_VOICES } };
  const blobs = Object.fromEntries(NATURAL_VOICES.map(voice => [voice.id, [new Blob([voice.id])]]));
  await store.putAudioPack(book, blobs);
  assert.equal(writes[0], book);
  assert.deepEqual(writes[1].tracks.map(track => track.key), NATURAL_VOICES.map(voice => `book:${voice.id}:0`));
  assert.deepEqual(writes[1].tracks.map(track => track.blob), NATURAL_VOICES.map(voice => blobs[voice.id][0]));
});

test('online audio existence check shares a transaction with the audio write', async () => {
  for (const exists of [false, true]) {
    const store = new BookStore();
    const writes = [];
    store.init = async () => store;
    store.db = { transaction(names, mode) {
      assert.deepEqual(names, ['books', 'audio']);
      assert.equal(mode, 'readwrite');
      let read;
      const transaction = { objectStore(name) {
        return name === 'books'
          ? { get(id) { assert.equal(id, 'book'); read = { result: exists ? { id } : undefined }; return read; } }
          : { put(value) { writes.push(value); } };
      } };
      queueMicrotask(() => { read.onsuccess(); transaction.oncomplete(); });
      return transaction;
    } };
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    assert.equal(await store.putAudioIfBookExists('book', 2, blob, 'yunxi'), exists);
    assert.equal(writes.length, exists ? 1 : 0);
    if (exists) assert.equal(writes[0].key, 'book:yunxi:2');
  }
});
