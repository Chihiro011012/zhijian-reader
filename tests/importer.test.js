import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { parseDocument, parseTextDocument, parseDocx } from '../src/importer.js';

const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const docx = (body, styles) => zipSync({
  'word/document.xml': strToU8(`<w:document xmlns:w="${ns}"><w:body>${body}</w:body></w:document>`),
  ...(styles ? { 'word/styles.xml': strToU8(`<w:styles xmlns:w="${ns}">${styles}</w:styles>`) } : {}),
});

test('Markdown preserves selectable prose paragraphs and discovers chapters', () => {
  const book = parseTextDocument('\uFEFF---\nauthor: 我\n---\n# 山海来信\n\n## 第一章 归来\n她推开了**旧木门**。\n风穿过[院子](https://example.com)。\n\n> “你回来了。”\n\n![封面](cover.png)\n<!-- 私密备注 -->\n第二章 雨声\n\n新的故事。', '手稿.markdown', 'md');
  assert.equal(book.title, '山海来信');
  assert.deepEqual(book.paragraphs.map((p) => p.text), ['第一章 归来', '她推开了旧木门。', '风穿过院子。', '“你回来了。”', '第二章 雨声', '新的故事。']);
  assert.deepEqual(book.chapters.map((c) => c.index), [0, 4]);
  assert.equal(book.format, 'md');
  assert.equal(book.wordCount, Array.from(book.paragraphs.map((p) => p.text).join('').replace(/\s/g, '')).length);
});

test('Plain text retains punctuation and uses the filename when the first heading is a chapter', () => {
  const book = parseTextDocument('第一章 春风\r\n\r\n她说：“等一等。”\r\n这里的 * 是星号。\r\n\r\n尾声\r\n故事结束。', '远山.txt');
  assert.equal(book.title, '远山');
  assert.deepEqual(book.chapters, [{ title: '第一章 春风', index: 0 }, { title: '尾声', index: 3 }]);
  assert.equal(book.paragraphs[2].text, '这里的 * 是星号。');
  assert.equal(book.paragraphs[1].type, 'paragraph');
});

test('Documents without headings expose one body chapter starting at the first paragraph', () => {
  const book = parseTextDocument('故事从这里开始。\n\n她抬起头。', '短篇.txt');
  assert.deepEqual(book.chapters, [{ title: '正文', index: 0 }]);
});

test('Documents with a preface before the first chapter expose both navigation entries', () => {
  const book = parseTextDocument('写在故事前面。\n\n这是献给妈妈的话。\n\n第一章 归来\n她推开门。', '手稿.txt');
  assert.deepEqual(book.chapters, [{ title: '正文', index: 0 }, { title: '第一章 归来', index: 2 }]);
  assert.equal(book.paragraphs[book.chapters[0].index].text, '写在故事前面。');
});

test('Markdown supports setext titles and strips visible formatting without executing HTML', () => {
  const book = parseTextDocument('月光\n===\n\n- [x] 她拾起 `信`，说：“&lt;你好&gt;”。\n\n<script>alert(1)</script>\n\n### 后记\n__感谢__ 每一位读者。', 'novel.md', 'md');
  assert.equal(book.title, '月光');
  assert.deepEqual(book.paragraphs.map((p) => p.text), ['她拾起 信，说：“<你好>”。', '后记', '感谢 每一位读者。']);
});

test('DOCX preserves runs, line breaks, chapter styles and visible text only', () => {
  const zipped = docx(
    '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>山海来信</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="NovelChapter"/></w:pPr><w:r><w:t>归来</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>她推开</w:t></w:r><w:r><w:t>木门。</w:t><w:br/><w:t>风吹来了。</w:t></w:r><w:del><w:r><w:delText>不应出现</w:delText></w:r></w:del><w:r><w:instrText>PAGE</w:instrText></w:r><w:comment><w:r><w:t>批注</w:t></w:r></w:comment></w:p>'
    + '<w:p><w:r><w:t>第二章 雨声</w:t></w:r></w:p>',
    '<w:style w:styleId="Title"><w:name w:val="Title"/></w:style>'
    + '<w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>'
    + '<w:style w:styleId="NovelChapter"><w:name w:val="章节"/><w:basedOn w:val="Heading2"/></w:style>',
  );
  const book = parseDocx(zipped, '手稿.docx', DOMParser);
  assert.equal(book.title, '山海来信');
  assert.equal(book.format, 'docx');
  assert.deepEqual(book.paragraphs[0], { text: '归来', type: 'heading', level: 2 });
  assert.equal(book.paragraphs[1].text, '她推开木门。\n风吹来了。');
  assert.deepEqual(book.chapters.map((c) => c.index), [0, 2]);
});

test('Word Title metadata followed by a chapter does not create an empty title chapter', () => {
  const zipped = docx(
    '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>山海来信</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 归来</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>她推开门。</w:t></w:r></w:p>',
  );
  const book = parseDocx(zipped, '手稿.docx', DOMParser);
  assert.equal(book.title, '山海来信');
  assert.deepEqual(book.chapters, [{ title: '第一章 归来', index: 0 }]);
  assert.deepEqual(book.paragraphs.map((p) => p.text), ['第一章 归来', '她推开门。']);
});

test('A title-only document keeps its title as readable content', () => {
  const markdown = parseTextDocument('# 还未写完的故事', '手稿.md', 'md');
  assert.equal(markdown.title, '还未写完的故事');
  assert.deepEqual(markdown.paragraphs, [{ text: '还未写完的故事', type: 'heading', level: 1 }]);
  const word = parseDocx(docx('<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>还未写完的故事</w:t></w:r></w:p>'), '手稿.docx', DOMParser);
  assert.equal(word.title, '还未写完的故事');
  assert.deepEqual(word.paragraphs, markdown.paragraphs);
});

test('DOCX supports alternate XML prefixes and excludes textboxes / deleted paragraphs', () => {
  const zipped = zipSync({ 'word/document.xml': strToU8(`<a:document xmlns:a="${ns}"><a:body><a:p><a:r><a:t>正文</a:t></a:r><a:drawing><a:p><a:r><a:t>文本框</a:t></a:r></a:p></a:drawing></a:p><a:del><a:p><a:r><a:t>已删除段落</a:t></a:r></a:p></a:del></a:body></a:document>`) });
  const book = parseDocx(zipped, '正文.docx', DOMParser);
  assert.deepEqual(book.paragraphs, [{ text: '正文', type: 'paragraph' }]);
});

test('Empty, unsupported, old Word, oversized and invalid documents report useful errors', async () => {
  assert.throws(() => parseTextDocument(' \n \t', 'empty.txt'), /没有可阅读/);
  await assert.rejects(parseDocument({ name: '旧手稿.doc', size: 10 }), /另存为.*\.docx/);
  await assert.rejects(parseDocument({ name: '书.pdf', size: 10 }), /请选择 Markdown/);
  await assert.rejects(parseDocument({ name: '书.txt', size: 0 }), /文件是空/);
  await assert.rejects(parseDocument({ name: '书.txt', size: 20 * 1024 * 1024 + 1 }), /超过 20 MB/);
  assert.throws(() => parseDocx(new Uint8Array([1, 2, 3]), 'bad.docx', DOMParser), /无法读取/);
  assert.throws(() => parseDocx(zipSync({ 'hello.txt': strToU8('hello') }), 'bad.docx', DOMParser), /不是有效/);
});

test('DOCX refuses excessive ZIP expansion before extracting content', () => {
  const zipped = zipSync({ 'word/document.xml': new Uint8Array(24 * 1024 * 1024 + 1) });
  assert.throws(() => parseDocx(zipped, 'large.docx', DOMParser), /解压后过大/);
});

test('DOCX rejects XML entity declarations', () => {
  const zipped = zipSync({ 'word/document.xml': strToU8(`<!DOCTYPE document [<!ENTITY x "bad">]><w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`) });
  assert.throws(() => parseDocx(zipped, 'unsafe.docx', DOMParser), /XML 内容/);
});

test('DOCX rejects malformed XML rather than importing a partially recovered document', () => {
  const zipped = zipSync({ 'word/document.xml': strToU8(`<w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:t>正文</w:r></w:p></w:body></w:document>`) });
  assert.throws(() => parseDocx(zipped, 'broken.docx', DOMParser), /内容已损坏/);
});

test('parseDocument accepts uppercase Markdown and UTF-16 text exported by Word', async () => {
  const markdown = new File(['# 故事\n\n正文。'], '书.MD', { type: 'text/markdown' });
  assert.equal((await parseDocument(markdown)).title, '故事');
  const utf16 = new Uint8Array([0xff, 0xfe, 0x63, 0x6b, 0x87, 0x65]);
  assert.equal((await parseDocument(new File([utf16], '手稿.txt'))).paragraphs[0].text, '正文');
});
