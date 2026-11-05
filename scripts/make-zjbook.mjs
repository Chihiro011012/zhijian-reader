#!/usr/bin/env node

/**
 * Build a portable .zjbook package with pre-generated Edge TTS audio.
 *
 * The text is sent to Microsoft's public Edge TTS endpoint by the edge-tts
 * command. The resulting package is self-contained: importing it later does
 * not require a network connection or the author's computer to be online.
 */
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { parseDocx, parseTextDocument } from '../src/importer.js';
import { canonicalVoiceId, NATURAL_VOICES } from '../src/voices.js';

export const DEFAULT_VOICES = NATURAL_VOICES;

const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 500 * 1024 * 1024;

function usage() {
  return `用法：node scripts/make-zjbook.mjs --input 小说.md --output 妈妈听书.zjbook [选项]

选项：
  --voices xiaoxiao,xiaoyi,yunxi,yunyang
                         生成哪些声音（默认四种，可只选其中一种或几种）
  --edge-tts PATH         edge-tts 可执行文件（默认从 PATH 查找）
  --dry-run               只检查文档和列出将生成的文件，不连接语音服务

生成声音会将正文段落发送到在线 Edge TTS 服务。请勿把私人或未发表的原稿交给不接受该风险的服务；也可以只在本机阅读，不生成听书包。
`;
}

export function parseArgs(argv) {
  const options = { voices: [...DEFAULT_VOICES], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    const [key, inline] = arg.split('=', 2);
    if (!['--input', '--output', '--voices', '--edge-tts'].includes(key)) {
      throw new Error(`未知选项：${arg}\n${usage()}`);
    }
    const value = inline ?? argv[++index];
    if (!value) throw new Error(`${key} 缺少值。\n${usage()}`);
    if (key === '--input') options.input = value;
    else if (key === '--output') options.output = value;
    else if (key === '--edge-tts') options.edgeTts = value;
    else if (key === '--voices') {
      const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
      options.voices = ids.map((id) => {
        const canonicalId = canonicalVoiceId(id);
        const preset = DEFAULT_VOICES.find((voice) => voice.id === canonicalId);
        if (!preset) throw new Error(`不认识的声音 ID：${id}。可用值为 xiaoxiao,xiaoyi,yunxi,yunyang。`);
        return preset;
      });
    }
  }
  if (!options.input && !options.help) throw new Error(`请使用 --input 指定 Markdown、TXT 或 DOCX 文档。\n${usage()}`);
  if (!options.output && options.input) options.output = `${options.input.replace(/\.[^.]+$/, '')}.zjbook`;
  if (!options.voices.length) throw new Error('至少选择一种声音。');
  if (new Set(options.voices.map((voice) => voice.id)).size !== options.voices.length) throw new Error('请勿重复选择同一种声音。');
  return options;
}

async function parseInput(filePath) {
  const absolute = resolve(filePath);
  const fileName = basename(absolute);
  const extension = extname(fileName).slice(1).toLowerCase();
  const bytes = new Uint8Array(await readFile(absolute));
  if (extension === 'docx') return parseDocx(bytes, fileName, DOMParser);
  if (extension === 'md' || extension === 'markdown' || extension === 'txt') {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    let text = new TextDecoder(encoding).decode(bytes);
    if (encoding === 'utf-8' && text.includes('\ufffd')) {
      try { text = new TextDecoder('gb18030').decode(bytes); } catch { /* use UTF-8 */ }
    }
    return parseTextDocument(text, fileName, extension === 'txt' ? 'txt' : 'md');
  }
  throw new Error('只支持 Markdown（.md）、TXT 或 Word（.docx）文档。');
}

function runEdgeTts(command, textPath, voice, outputPath) {
  return new Promise((resolvePromise, reject) => {
    const args = ['--voice', voice, '--file', textPath, '--write-media', outputPath];
    const windowsPython = process.platform === 'win32' && command === 'edge-tts';
    const child = spawn(windowsPython ? 'py' : command, windowsPython ? ['-c', 'from edge_tts.util import main; main()', ...args] : args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (error.code === 'ENOENT') reject(new Error('找不到 edge-tts。请先运行 py -m pip install --user edge-tts，然后将 Python 的 Scripts 文件夹加入 PATH，或用 --edge-tts 指定 edge-tts.exe。'));
      else reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`edge-tts 生成失败（退出码 ${code}）：${stderr.trim() || '请检查网络和声音 ID。'}`));
    });
  });
}

export function makeManifest(book, voices, audio) {
  return {
    version: 1,
    title: book.title,
    fileName: book.fileName,
    format: book.format,
    paragraphs: book.paragraphs,
    chapters: book.chapters,
    wordCount: book.wordCount,
    voices,
    audio,
  };
}

/** Build and write a .zjbook. Exported for tests and other local tooling. */
export async function buildPackage({ input, output, voices = DEFAULT_VOICES, edgeTts = 'edge-tts', dryRun = false, synthesize = runEdgeTts }) {
  if (resolve(input) === resolve(output)) throw new Error('输出文件不能覆盖小说原稿，请另选 .zjbook 文件名。');
  if (!Array.isArray(voices) || !voices.length || voices.length > DEFAULT_VOICES.length || new Set(voices.map((voice) => voice?.id)).size !== voices.length || voices.some((voice) => !DEFAULT_VOICES.some((preset) => preset.id === voice?.id && preset.name === voice?.name))) {
    throw new Error('请从晓晓、晓伊、云希、云扬中选择一至四种不重复的声音。');
  }
  voices = voices.map((voice) => DEFAULT_VOICES.find((preset) => preset.id === voice.id));
  const book = await parseInput(input);
  const paragraphs = book.paragraphs.map((paragraph) => paragraph.text);
  if (paragraphs.length > 100000) throw new Error('段落超过 100000 段，请把小说拆成几卷。');
  const oversized = paragraphs.findIndex((paragraph) => Array.from(paragraph).length > 3000);
  if (oversized !== -1) throw new Error(`第 ${oversized + 1} 段超过 3000 个字符，在线语音服务可能无法处理。请先拆分这一段。`);
  const audio = Object.fromEntries(voices.map((voice) => [voice.id, paragraphs.map((_, index) => `audio/${voice.id}/${String(index).padStart(6, '0')}.mp3`)]));
  const manifest = makeManifest(book, voices, audio);
  if (dryRun) return { manifest, output: resolve(output), bytes: null };
  let exists = true;
  try { await access(resolve(output)); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (exists) throw new Error('同名听书包已经存在，请用 --output 指定新名字，或先备份并移走旧包。');

  const temporary = await mkdtemp(join(tmpdir(), 'zjbook-'));
  try {
    const entries = { 'book.json': strToU8(JSON.stringify(manifest)) };
    let expandedBytes = entries['book.json'].byteLength;
    if (expandedBytes > 20 * 1024 * 1024) throw new Error('正文清单超过 20 MB，请将原稿拆成几卷。');
    for (const voice of voices) {
      const voiceDirectory = join(temporary, 'audio', voice.id);
      await mkdir(voiceDirectory, { recursive: true });
      for (let index = 0; index < paragraphs.length; index += 1) {
        const path = join(voiceDirectory, `${String(index).padStart(6, '0')}.mp3`);
        const textPath = join(temporary, 'paragraph.txt');
        await writeFile(textPath, paragraphs[index], 'utf8');
        process.stdout.write(`生成 ${voice.label} ${index + 1}/${paragraphs.length}\r`);
        await synthesize(edgeTts, textPath, voice.name, path);
        entries[audio[voice.id][index]] = new Uint8Array(await readFile(path));
        if (!entries[audio[voice.id][index]].byteLength) throw new Error(`第 ${index + 1} 段未生成音频，请稍后重试。`);
        expandedBytes += entries[audio[voice.id][index]].byteLength;
        if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('音频超过 500 MB，请拆分原稿或只生成一种声音。');
      }
    }
    const archive = zipSync(entries, { level: 6 });
    if (archive.byteLength > MAX_PACKAGE_BYTES) {
      throw new Error('生成的听书包超过 300 MB。请拆分原稿，或只生成一种声音后再试。');
    }
    const destination = resolve(output);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, archive, { flag: 'wx' });
    process.stdout.write('\n');
    return { manifest, output: destination, bytes: archive.byteLength };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  if (!options.dryRun) console.log('将把正文逐段发送到在线 Edge TTS 服务，生成时间取决于篇幅和网络。');
  const result = await buildPackage(options);
  if (options.dryRun) {
    console.log(`将生成 ${result.manifest.paragraphs.length} 段 × ${result.manifest.voices.length} 种声音。`);
    console.log(result.output);
  } else {
    console.log(`已生成 ${result.output}（约 ${(result.bytes / 1024 / 1024).toFixed(1)} MB）。`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\n${error.message}`); process.exitCode = 1; });
}
