import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { parseAudioPackage } from '../src/audio-package.js';
import { NATURAL_VOICES } from '../src/voices.js';

const paragraph = { text: '第一段正文。', type: 'paragraph' };
const manifest = overrides => ({
  version: 1,
  title: '测试小说',
  fileName: '手稿.md',
  format: 'md',
  paragraphs: [paragraph],
  chapters: [{ title: '正文', index: 0 }],
  voices: [{ id: 'female', name: 'zh-CN-XiaoxiaoNeural', label: '女声' }, { id: 'male', name: 'zh-CN-YunxiNeural', label: '男声' }],
  audio: { female: ['audio/female/000000.mp3'], male: ['audio/male/000000.mp3'] },
  ...overrides,
});
const packageFile = (data, name = '小说.zjbook') => new File([zipSync(data)], name);
const json = value => strToU8(JSON.stringify(value));

test('parses a two voice package and preserves text-to-audio paragraph alignment', async () => {
  const file = packageFile({
    'book.json': json(manifest()),
    'audio/female/000000.mp3': new Uint8Array([1, 2, 3]),
    'audio/male/000000.mp3': new Uint8Array([4, 5]),
  });
  const result = await parseAudioPackage(file);
  assert.equal(result.book.title, '测试小说');
  assert.deepEqual(result.book.audioPack.voices.map(voice => voice.id), ['female', 'male']);
  assert.deepEqual(result.book.audioPack.voices.map(voice => voice.label), ['晓晓 · 女声', '云希 · 男声']);
  assert.equal(result.audioBlobs.female.length, 1);
  assert.deepEqual([...new Uint8Array(await result.audioBlobs.female[0].arrayBuffer())], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await result.audioBlobs.male[0].arrayBuffer())], [4, 5]);
});

test('rejects a missing segment and manifest paths that do not exactly map paragraphs', async () => {
  const missing = packageFile({ 'book.json': json(manifest()), 'audio/female/000000.mp3': new Uint8Array([1]) });
  await assert.rejects(parseAudioPackage(missing), /缺少第 1 段云希 · 男声音频/);
  const traversalManifest = manifest({ audio: { female: ['../../other'], male: ['audio/male/000000.mp3'] } });
  const traversal = packageFile({ 'book.json': json(traversalManifest) });
  await assert.rejects(parseAudioPackage(traversal), /音频与正文段落不匹配/);
});

test('rejects unsafe extra paths and unsupported extensions', async () => {
  const unsafe = packageFile({
    'book.json': json(manifest()),
    'audio/female/000000.mp3': new Uint8Array([1]),
    'audio/male/000000.mp3': new Uint8Array([2]),
    '../outside.txt': strToU8('bad'),
  });
  await assert.rejects(parseAudioPackage(unsafe), /不支持的文件或路径/);
  await assert.rejects(parseAudioPackage(new File(['x'], 'book.zip')), /纸间听书包/);
});

test('rejects malformed audio metadata and unexpected files', async () => {
  const wrongCount = manifest({ audio: { female: [], male: ['audio/male/000000.mp3'] } });
  await assert.rejects(parseAudioPackage(packageFile({ 'book.json': json(wrongCount) })), /音频与正文段落不匹配/);
  const unexpected = packageFile({
    'book.json': json(manifest()),
    'audio/female/000000.mp3': new Uint8Array([1]),
    'audio/male/000000.mp3': new Uint8Array([2]),
    'extra.txt': strToU8('extra'),
  });
  await assert.rejects(parseAudioPackage(unexpected), /不支持的文件或路径/);
});

test('imports all four fixed voices with independent paragraph-aligned audio', async () => {
  const paragraphs = [paragraph, { text: '第二段正文。', type: 'paragraph' }];
  const audio = Object.fromEntries(NATURAL_VOICES.map(voice => [voice.id, paragraphs.map((_, index) => `audio/${voice.id}/${String(index).padStart(6, '0')}.mp3`)]));
  const entries = { 'book.json': json(manifest({ paragraphs, voices: NATURAL_VOICES, audio })) };
  for (const [voiceIndex, voice] of NATURAL_VOICES.entries()) {
    for (const [index, path] of audio[voice.id].entries()) entries[path] = new Uint8Array([voiceIndex + 1, index + 1]);
  }
  const result = await parseAudioPackage(packageFile(entries));
  assert.deepEqual(result.book.audioPack.voices, NATURAL_VOICES);
  assert.equal(result.book.audioPack.trackCount, 2);
  for (const [voiceIndex, voice] of NATURAL_VOICES.entries()) {
    assert.equal(result.audioBlobs[voice.id].length, 2);
    assert.deepEqual([...new Uint8Array(await result.audioBlobs[voice.id][1].arrayBuffer())], [voiceIndex + 1, 2]);
  }
});

test('rejects unapproved voice names and duplicate canonical voices in legacy packages', async () => {
  for (const voices of [
    [{ id: 'female', name: 'zh-CN-UnapprovedNeural', label: '自定义' }],
    [{ id: 'xiaoxiao', name: 'zh-CN-XiaoyiNeural', label: '冒名声音' }],
    [NATURAL_VOICES[0], { id: 'female', name: NATURAL_VOICES[0].name, label: '重复女声' }],
  ]) {
    const audio = Object.fromEntries(voices.map(voice => [voice.id, [`audio/${voice.id}/000000.mp3`]]));
    await assert.rejects(parseAudioPackage(packageFile({ 'book.json': json(manifest({ voices, audio })) })), /声音信息格式错误/);
  }
});
