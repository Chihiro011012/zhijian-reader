import test from 'node:test';
import assert from 'node:assert/strict';
import { onlineConsent } from '../src/online-consent.js';

test('online speech consent is explicit, persistent, revocable and scoped to one service', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const consent = onlineConsent('https://voice.example/v1/tts', storage);
  assert.equal(consent.accepted, false);
  consent.allow();
  assert.equal(consent.accepted, true);
  assert.equal(onlineConsent('https://voice.example/v1/tts', storage).accepted, true);
  assert.equal(onlineConsent('https://different.example/v1/tts', storage).accepted, false);
  consent.revoke();
  assert.equal(consent.accepted, false);
  assert.equal(onlineConsent('https://voice.example/v1/tts', storage).accepted, false);
});

test('blocked preference storage still requires consent each session', () => {
  const storage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
  const consent = onlineConsent('https://voice.example/v1/tts', storage);
  assert.equal(consent.accepted, false);
  consent.allow();
  assert.equal(consent.accepted, true);
  assert.equal(onlineConsent('https://voice.example/v1/tts', storage).accepted, false);
  consent.revoke();
  assert.equal(consent.accepted, false);
});
