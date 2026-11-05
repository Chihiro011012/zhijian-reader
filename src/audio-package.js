import { unzipSync, strFromU8 } from 'fflate';
import { NATURAL_VOICES, canonicalVoiceId, packageVoiceFor } from './voices.js';

export const AUDIO_PACKAGE_LIMITS = Object.freeze({
  compressedBytes: 300 * 1024 * 1024,
  expandedBytes: 500 * 1024 * 1024,
  manifestBytes: 20 * 1024 * 1024,
  trackBytes: 20 * 1024 * 1024,
  paragraphs: 100000,
});

const invalid = message => new Error(`听书包${message}，请重新生成后导入。`);
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const pathFor = (voiceId, index) => `audio/${voiceId}/${String(index).padStart(6, '0')}.mp3`;
const acceptedVoiceIds = [...NATURAL_VOICES.map(voice => voice.id), 'female', 'male'];
const audioPath = new RegExp(`^audio/(${acceptedVoiceIds.join('|')})/\\d{6}\\.mp3$`);
const audioDirectory = new RegExp(`^audio/(${acceptedVoiceIds.join('|')})/$`);

function validateManifest(manifest) {
  if (!isRecord(manifest) || manifest.version !== 1) throw invalid('版本不受支持');
  if (typeof manifest.title !== 'string' || !manifest.title.trim() || manifest.title.length > 1000) throw invalid('缺少有效书名');
  if (!Array.isArray(manifest.paragraphs) || !manifest.paragraphs.length || manifest.paragraphs.length > AUDIO_PACKAGE_LIMITS.paragraphs) throw invalid('缺少正文或段落过多');
  let textBytes = 0;
  const paragraphs = manifest.paragraphs.map(paragraph => {
    if (!isRecord(paragraph) || typeof paragraph.text !== 'string' || !paragraph.text.trim() || !['heading', 'paragraph'].includes(paragraph.type)) throw invalid('正文段落格式错误');
    textBytes += paragraph.text.length;
    if (textBytes > AUDIO_PACKAGE_LIMITS.manifestBytes) throw invalid('正文过大，请拆成几卷');
    const result = { text: paragraph.text, type: paragraph.type };
    if (paragraph.type === 'heading') result.level = Number.isInteger(paragraph.level) && paragraph.level >= 1 && paragraph.level <= 9 ? paragraph.level : 1;
    return result;
  });
  if (!Array.isArray(manifest.chapters) || !manifest.chapters.length) throw invalid('缺少章节目录');
  let previous = -1;
  const chapters = manifest.chapters.map(chapter => {
    if (!isRecord(chapter) || typeof chapter.title !== 'string' || !chapter.title.trim() || chapter.title.length > 1000 || !Number.isInteger(chapter.index) || chapter.index <= previous || chapter.index >= paragraphs.length) throw invalid('章节目录格式错误');
    previous = chapter.index;
    return { title: chapter.title, index: chapter.index };
  });
  if (chapters[0].index !== 0) throw invalid('章节目录必须从第一段开始');
  if (!Array.isArray(manifest.voices) || manifest.voices.length < 1 || manifest.voices.length > NATURAL_VOICES.length || !isRecord(manifest.audio)) throw invalid('缺少声音信息');
  const ids = new Set();
  const canonicalIds = new Set();
  const voices = manifest.voices.map(voice => {
    if (!isRecord(voice) || ids.has(voice.id) || typeof voice.name !== 'string' || !voice.name || voice.name.length > 200 || typeof voice.label !== 'string' || !voice.label || voice.label.length > 100) throw invalid('声音信息格式错误');
    const preset = packageVoiceFor(voice.id, voice.name);
    const canonicalId = canonicalVoiceId(voice.id);
    if (!preset || canonicalIds.has(canonicalId)) throw invalid('声音信息格式错误');
    ids.add(voice.id);
    canonicalIds.add(canonicalId);
    const paths = manifest.audio[voice.id];
    if (!Array.isArray(paths) || paths.length !== paragraphs.length || paths.some((path, index) => path !== pathFor(voice.id, index))) throw invalid('音频与正文段落不匹配');
    return { id: voice.id, name: preset.name, label: preset.label };
  });
  if (Object.keys(manifest.audio).some(id => !ids.has(id))) throw invalid('包含未知声音');
  return {
    title: manifest.title.trim(),
    fileName: '',
    format: ['md', 'txt', 'docx'].includes(manifest.format) ? manifest.format : 'txt',
    paragraphs,
    chapters,
    wordCount: paragraphs.reduce((sum, paragraph) => sum + Array.from(paragraph.text.replace(/\s/g, '')).length, 0),
    audioPack: { version: 1, voices, trackCount: paragraphs.length, sourceFileName: typeof manifest.fileName === 'string' ? manifest.fileName.slice(0, 1000) : '' },
  };
}

/** Import text and prerecorded voices together. No network request is made. */
export async function parseAudioPackage(file) {
  if (!file || typeof file.name !== 'string' || !/\.zjbook$/i.test(file.name) || typeof file.arrayBuffer !== 'function') throw new Error('请选择纸间听书包（.zjbook）。');
  if (!file.size) throw new Error('这个听书包是空的，请重新选择。');
  if (file.size > AUDIO_PACKAGE_LIMITS.compressedBytes) throw new Error('听书包超过 300 MB，请在生成时把小说拆成几卷，再分别导入。');
  let files;
  let expandedBytes = 0;
  let entries = 0;
  const entryNames = new Set();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > AUDIO_PACKAGE_LIMITS.compressedBytes) throw new Error('PACKAGE_LIMIT');
    files = unzipSync(bytes, {
      filter(entry) {
        entries += 1;
        if (entryNames.has(entry.name)) throw new Error('DUPLICATE_PATH');
        entryNames.add(entry.name);
        expandedBytes += entry.originalSize;
        if (expandedBytes > AUDIO_PACKAGE_LIMITS.expandedBytes || entries > AUDIO_PACKAGE_LIMITS.paragraphs * NATURAL_VOICES.length + NATURAL_VOICES.length + 2) throw new Error('PACKAGE_LIMIT');
        if (entry.name === 'audio/' || audioDirectory.test(entry.name)) return false;
        if (entry.name !== 'book.json' && !audioPath.test(entry.name)) throw new Error('UNSAFE_PATH');
        const limit = entry.name === 'book.json' ? AUDIO_PACKAGE_LIMITS.manifestBytes : AUDIO_PACKAGE_LIMITS.trackBytes;
        if (entry.originalSize > limit) throw new Error('PACKAGE_LIMIT');
        return true;
      },
    });
  } catch (error) {
    if (error.message === 'PACKAGE_LIMIT') throw new Error('听书包解压后过大，请把小说拆成几卷后重新生成。');
    if (error.message === 'UNSAFE_PATH') throw invalid('包含不支持的文件或路径');
    if (error.message === 'DUPLICATE_PATH') throw invalid('包含重复文件路径');
    throw invalid('无法解压或文件已损坏');
  }
  if (!files['book.json']) throw invalid('缺少 book.json');
  let manifest;
  try { manifest = JSON.parse(strFromU8(files['book.json'])); } catch { throw invalid('目录文件已损坏'); }
  const book = validateManifest(manifest);
  const expectedPaths = new Set(['book.json']);
  const audioBlobs = {};
  let audioBytes = 0;
  for (const voice of book.audioPack.voices) {
    audioBlobs[voice.id] = book.paragraphs.map((paragraph, index) => {
      const path = pathFor(voice.id, index);
      expectedPaths.add(path);
      const data = files[path];
      if (!data?.byteLength) throw invalid(`缺少第 ${index + 1} 段${voice.label}音频`);
      audioBytes += data.byteLength;
      return new Blob([data], { type: 'audio/mpeg' });
    });
  }
  if (Object.keys(files).some(path => !expectedPaths.has(path))) throw invalid('包含与目录不一致的音频');
  book.audioPack.bytes = audioBytes;
  book.audioPack.packageName = file.name;
  book.fileName = file.name;
  return { book, audioBlobs };
}
