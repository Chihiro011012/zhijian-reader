import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { buildPackage, DEFAULT_VOICES, parseArgs } from '../scripts/make-zjbook.mjs';

test('generator defaults to the four fixed Chinese natural voices', () => {
  const defaults = parseArgs(['--input', '短篇.md']);
  assert.equal(defaults.output, '短篇.zjbook');
  assert.deepEqual(defaults.voices.map((voice) => voice.id), ['xiaoxiao', 'xiaoyi', 'yunxi', 'yunyang']);
  assert.deepEqual(defaults.voices.map((voice) => voice.name), ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural']);
  assert.deepEqual(parseArgs(['--input', 'x.md', '--voices', 'xiaoyi,yunyang']).voices.map((voice) => voice.id), ['xiaoyi', 'yunyang']);
  assert.deepEqual(parseArgs(['--input', 'x.md', '--voices', 'female,male']).voices.map((voice) => voice.id), ['xiaoxiao', 'yunxi']);
  assert.throws(() => parseArgs(['--input', 'x.md', '--voices', 'unknown']), /声音 ID/);
  assert.throws(() => parseArgs(['--input', 'x.md', '--voices', 'xiaoyi,xiaoyi']), /重复/);
  assert.throws(() => parseArgs(['--input', 'x.md', '--voices', 'female,xiaoxiao']), /重复/);
  assert.throws(() => parseArgs(['--input', 'x.md', '--voices', ',']), /至少/);
  assert.throws(() => parseArgs(['--input', 'x.md', '--female', 'other']), /未知选项/);
  assert.throws(() => parseArgs(['--input', 'x.md', '--male', 'other']), /未知选项/);
});

test('dry run never generates audio and keeps reading paragraphs aligned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zjbook-test-'));
  try {
    const input = join(directory, '短篇.md');
    await writeFile(input, '# 窗边\n\n## 第一章 纸船\n\n清晨，一只纸船停在花盆旁。\n\n她把它轻轻放进水里。', 'utf8');
    const result = await buildPackage({ input, output: join(directory, '短篇.zjbook'), dryRun: true, synthesize: () => { throw new Error('must not run'); } });
    assert.equal(result.manifest.version, 1);
    assert.equal(result.manifest.title, '窗边');
    assert.equal(result.manifest.paragraphs.length, 3);
    for (const voice of DEFAULT_VOICES) {
      assert.deepEqual(result.manifest.audio[voice.id], [0, 1, 2].map((index) => `audio/${voice.id}/${String(index).padStart(6, '0')}.mp3`));
    }
    assert.equal(result.bytes, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('complete package writes all four voice tracks with matching original text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zjbook-test-'));
  try {
    const input = join(directory, '短篇.txt');
    const output = join(directory, '短篇.zjbook');
    const texts = ['风把窗帘吹成了一面小小的帆。', '阿宁坐在桌旁，听见远处传来钟声。'];
    await writeFile(input, texts.join('\n\n'), 'utf8');
    const calls = [];
    await buildPackage({ input, output, synthesize: async (_command, textPath, voice, destination) => {
      calls.push({ voice, text: await readFile(textPath, 'utf8') });
      await writeFile(destination, new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]));
    } });
    assert.deepEqual(calls.map((call) => call.text), DEFAULT_VOICES.flatMap(() => texts));
    assert.deepEqual(calls.map((call) => call.voice), DEFAULT_VOICES.flatMap((voice) => texts.map(() => voice.name)));
    const entries = unzipSync(await readFile(output));
    const manifest = JSON.parse(strFromU8(entries['book.json']));
    assert.equal(manifest.voices.length, 4);
    for (const voice of manifest.voices) {
      assert.equal(manifest.audio[voice.id].length, texts.length);
      for (const path of manifest.audio[voice.id]) assert.ok(entries[path]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('generator rejects duplicate, unknown and substituted voice definitions before reading input', async () => {
  const input = 'does-not-exist.md', output = 'does-not-exist.zjbook';
  for (const voices of [[], [DEFAULT_VOICES[0], DEFAULT_VOICES[0]], [{ id: 'other', name: 'other' }], [{ ...DEFAULT_VOICES[0], name: 'en-US-AriaNeural' }]]) {
    await assert.rejects(buildPackage({ input, output, voices, dryRun: true }), /选择/);
  }
});

test('generator preserves original documents and refuses to overwrite a prior package', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zjbook-test-'));
  try {
    const input = join(directory, '短篇.txt');
    const output = join(directory, '已有.zjbook');
    await writeFile(input, '沿着河岸走，他看见第一盏灯亮了。', 'utf8');
    await writeFile(output, 'keep me', 'utf8');
    await assert.rejects(buildPackage({ input, output: input }), /原稿/);
    await assert.rejects(buildPackage({ input, output }), /已经存在/);
    assert.equal(await readFile(output, 'utf8'), 'keep me');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
