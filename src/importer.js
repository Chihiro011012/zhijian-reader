import { unzipSync, strFromU8 } from 'fflate';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 24 * 1024 * 1024;
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CHAPTER_PATTERN = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章回卷节部集篇](?:[\s　:：、.．—-].*|[^，。！？；]{0,30})|(?:序章|楔子|序言|前言|引子|终章|尾声|后记|番外)(?:[\s　:：、.．—-].*|[零〇一二三四五六七八九十百千万两\d]*))$/u;

function normalizeText(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '');
}

function baseTitle(fileName) {
  return String(fileName || '未命名小说').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').trim() || '未命名小说';
}

function isChapter(text) {
  return text.length <= 80 && CHAPTER_PATTERN.test(text);
}

function finalize(paragraphs, fileName, format, title) {
  const cleaned = paragraphs
    .map((paragraph) => ({ ...paragraph, text: paragraph.text.trim() }))
    .filter((paragraph) => paragraph.text);
  if (!cleaned.length) throw new Error('文档里没有可阅读的文字，请检查文件内容后重试。');
  // A document's display title is metadata, not a standalone empty chapter.
  // Preserve it as readable content when it is the document's only paragraph.
  if (title && cleaned.length > 1 && cleaned[0].type === 'heading' && cleaned[0].text === title.trim()) cleaned.shift();
  const chapters = cleaned.flatMap((paragraph, index) => (
    paragraph.type === 'heading' ? [{ title: paragraph.text, index }] : []
  ));
  if (chapters.length && chapters[0].index > 0) chapters.unshift({ title: '正文', index: 0 });
  if (!chapters.length) chapters.push({ title: '正文', index: 0 });
  return {
    title: title?.trim() || baseTitle(fileName),
    fileName: String(fileName || '未命名小说'),
    format,
    paragraphs: cleaned,
    chapters,
    wordCount: cleaned.reduce((sum, paragraph) => sum + Array.from(paragraph.text.replace(/\s/g, '')).length, 0),
  };
}

function decodeEntities(text) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
    const codePoint = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
}

function markdownText(line) {
  return decodeEntities(line
    .replace(/!\[[^\]]*\]\([^\n]*?\)/g, '')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    .replace(/\[([^\]]+)\]\([^\n]*?\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<https?:\/\/([^>]+)>/g, 'https://$1')
    .replace(/<[^>]*>/g, '')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(?<!\*)\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?!\*)/g, '$1')
    .replace(/(?<![\w_])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w_])/g, '$1')
    .replace(/\\([\\`*{}\[\]()#+\-.!_>~|])/g, '$1'))
    .trim();
}

/** Parse local Markdown or plain text without uploading its contents. */
export function parseTextDocument(text, fileName, format = 'txt') {
  if (!['md', 'txt'].includes(format)) throw new Error('不支持的文本格式，请使用 Markdown 或 TXT 文件。');
  let source = normalizeText(text);
  if (source.length > MAX_FILE_BYTES) throw new Error('文档超过 20 MB，请拆分成几份后导入。');
  if (format === 'md') {
    source = source
      .replace(/^---\s*\n[\s\S]*?\n(?:---|\.\.\.)\s*(?:\n|$)/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  }
  const lines = source.split('\n');
  const paragraphs = [];
  let title;
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].trim();
    if (!line) continue;
    let level;
    if (format === 'md') {
      const fenceMatch = line.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        if (!fence) fence = fenceMatch[1][0];
        else if (fenceMatch[1][0] === fence) fence = null;
        continue;
      }
      if (!fence) {
        if (/^\[[^\]]+\]:\s*\S/.test(line) || /^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(line)) continue;
        const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
        const setext = index + 1 < lines.length && /^\s*(={3,}|-{3,})\s*$/.exec(lines[index + 1]);
        if (heading) {
          level = heading[1].length;
          line = heading[2];
        } else if (setext) {
          level = setext[1][0] === '=' ? 1 : 2;
          index += 1;
        } else {
          line = line.replace(/^(?:>\s*)+/, '').replace(/^(?:[-+*]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s+/, '');
        }
      }
      line = markdownText(line);
    }
    if (!line) continue;
    const chapter = isChapter(line);
    if (level || chapter) {
      if (!paragraphs.length && level === 1 && !chapter) title = line;
      paragraphs.push({ text: line, type: 'heading', level: level || 1 });
    } else {
      paragraphs.push({ text: line, type: 'paragraph' });
    }
  }
  return finalize(paragraphs, fileName, format, title);
}

function localName(node) {
  return node.localName || node.nodeName?.split(':').pop();
}

function wordAttribute(node, name) {
  return node?.getAttributeNS?.(WORD_NS, name) || node?.getAttribute?.(`w:${name}`) || node?.getAttribute?.(name) || '';
}

function descendants(node, name) {
  return Array.from(node.getElementsByTagNameNS(WORD_NS, name));
}

function parseXml(bytes, DOMParserClass) {
  const xml = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Word 文档包含无法安全读取的 XML 内容，请另存为新的 .docx 文件。');
  let document;
  let malformed = false;
  try {
    const recordError = () => { malformed = true; };
    document = new DOMParserClass({ errorHandler: { warning: recordError, error: recordError, fatalError: recordError } })
      .parseFromString(xml, 'application/xml');
  } catch {
    throw new Error('Word 文档内容已损坏，请用 Word 重新另存为 .docx 后导入。');
  }
  if (malformed || !document?.documentElement || document.getElementsByTagName('parsererror').length) {
    throw new Error('Word 文档内容已损坏，请用 Word 重新另存为 .docx 后导入。');
  }
  return document;
}

function styleLevel(styleName) {
  const heading = String(styleName).match(/^(?:heading|标题)\s*([1-9])$/i);
  return heading ? Number(heading[1]) : undefined;
}

function readStyles(bytes, DOMParserClass) {
  const styles = new Map();
  if (!bytes) return styles;
  const xml = parseXml(bytes, DOMParserClass);
  for (const style of descendants(xml, 'style')) {
    const id = wordAttribute(style, 'styleId');
    const name = wordAttribute(descendants(style, 'name')[0], 'val') || id;
    const outline = wordAttribute(descendants(style, 'outlineLvl')[0], 'val');
    styles.set(id, {
      name,
      level: styleLevel(name) || styleLevel(id) || (outline !== '' && Number(outline) < 9 ? Number(outline) + 1 : undefined),
      basedOn: wordAttribute(descendants(style, 'basedOn')[0], 'val'),
    });
  }
  // Custom paragraph styles often inherit Word's built-in heading styles.
  for (const style of styles.values()) {
    let parentId = style.basedOn;
    const visited = new Set();
    while (!style.level && parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = styles.get(parentId);
      style.level = parent?.level || styleLevel(parentId);
      parentId = parent?.basedOn;
    }
  }
  return styles;
}

function paragraphText(paragraph) {
  let result = '';
  function walk(node) {
    const name = localName(node);
    if (['del', 'moveFrom', 'instrText', 'comment', 'drawing', 'pict', 'object'].includes(name)) return;
    if (name === 't') {
      result += node.textContent;
      return;
    }
    if (name === 'tab') result += '　';
    else if (name === 'br' || name === 'cr') result += '\n';
    else if (name === 'noBreakHyphen') result += '‑';
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
  }
  walk(paragraph);
  return result.trim();
}

/** Read the document body of an Office Open XML .docx file. */
export function parseDocx(buffer, fileName, DOMParserClass = globalThis.DOMParser) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('文档超过 20 MB，请拆分成几份后导入。');
  if (!DOMParserClass) throw new Error('当前浏览器无法读取 Word 文档，请先将文档另存为 Markdown 或 TXT。');
  let files;
  let expandedBytes = 0;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        expandedBytes += file.originalSize;
        if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('EXPANSION_LIMIT');
        const selected = file.name === 'word/document.xml' || file.name === 'word/styles.xml';
        if (selected && file.originalSize > MAX_XML_BYTES) throw new Error('EXPANSION_LIMIT');
        return selected;
      },
    });
  } catch (error) {
    if (error.message === 'EXPANSION_LIMIT') throw new Error('Word 文档解压后过大，请减少图片或拆分文档后导入。');
    throw new Error('无法读取这个 Word 文件，请确认它是有效的 .docx 文档。');
  }
  if (!files['word/document.xml']) throw new Error('这个文件不是有效的 Word 文档，请用 Word 另存为 .docx 后导入。');
  const document = parseXml(files['word/document.xml'], DOMParserClass);
  const body = descendants(document, 'body')[0];
  if (!body) throw new Error('Word 文档缺少正文，请用 Word 重新保存后导入。');
  const styles = readStyles(files['word/styles.xml'], DOMParserClass);
  const paragraphs = [];
  let title;
  for (const paragraph of descendants(body, 'p')) {
    // Text boxes and deleted paragraphs may contain nested paragraph nodes.
    let ancestor = paragraph.parentNode;
    let excluded = false;
    while (ancestor && ancestor !== body) {
      if (['del', 'moveFrom', 'comment', 'drawing', 'pict', 'object'].includes(localName(ancestor))) excluded = true;
      ancestor = ancestor.parentNode;
    }
    if (excluded) continue;
    const text = paragraphText(paragraph);
    if (!text) continue;
    const paragraphProperties = Array.from(paragraph.childNodes).find((node) => localName(node) === 'pPr');
    const styleId = paragraphProperties ? wordAttribute(descendants(paragraphProperties, 'pStyle')[0], 'val') : '';
    const style = styles.get(styleId);
    const outline = paragraphProperties ? wordAttribute(descendants(paragraphProperties, 'outlineLvl')[0], 'val') : '';
    const level = style?.level || styleLevel(styleId) || (outline !== '' && Number(outline) < 9 ? Number(outline) + 1 : undefined);
    const titleStyle = /^(?:title|标题)$/i.test(style?.name || styleId);
    if (!paragraphs.length && titleStyle) title = text;
    paragraphs.push(level || titleStyle || isChapter(text)
      ? { text, type: 'heading', level: level || 1 }
      : { text, type: 'paragraph' });
  }
  return finalize(paragraphs, fileName, 'docx', title);
}

/** Accept a browser File, keeping the entire import on the user's device. */
export async function parseDocument(file) {
  if (!file || typeof file.name !== 'string') throw new Error('请先选择一个文档。');
  if (file.size > MAX_FILE_BYTES) throw new Error('文档超过 20 MB，请拆分成几份后导入。');
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'doc') throw new Error('暂不支持旧版 .doc 文件。请在 Word 或 WPS 中打开它，选择“另存为”并保存为 .docx，再导入；也可以另存为 TXT。');
  if (!['md', 'markdown', 'txt', 'docx'].includes(extension)) throw new Error('请选择 Markdown（.md）、TXT 或 Word（.docx）文档。');
  if (file.size === 0) throw new Error('这个文件是空的，请选择有正文的文档。');
  if (extension === 'docx') return parseDocx(await file.arrayBuffer(), file.name);
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Word's Unicode text export uses UTF-16; ordinary Markdown/TXT use UTF-8.
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text = new TextDecoder(encoding).decode(bytes);
  if (encoding === 'utf-8' && text.includes('\ufffd')) {
    // Chinese Windows editors sometimes save TXT with the system GBK encoding.
    try {
      const fallback = new TextDecoder('gb18030').decode(bytes);
      if (!fallback.includes('\ufffd')) text = fallback;
    } catch { /* UTF-8 remains the best available decoding. */ }
  }
  return parseTextDocument(text, file.name, extension === 'txt' ? 'txt' : 'md');
}
