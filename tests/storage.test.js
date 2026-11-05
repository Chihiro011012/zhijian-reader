import test from 'node:test';
import assert from 'node:assert/strict';
import { BookStore, DEFAULT_SETTINGS, normalizeSettings, readSettings, writeSettings } from '../src/storage.js';

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
  assert.equal(normalizeSettings({ audioVoiceId: 'male' }).audioVoiceId, 'male');
  assert.equal(normalizeSettings({ audioVoiceId: 'robot' }).audioVoiceId, 'female');
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
    assert.equal(saved.voiceURI, source.voiceURI);
    assert.equal(saved.books, undefined);
    assert.equal(values.size, 1);
    assert.equal(values.keys().next().value, 'zhijian-settings-v1');
    assert.ok(!values.values().next().value.includes('Private manuscript'));
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
