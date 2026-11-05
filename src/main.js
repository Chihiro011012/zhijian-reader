import './style.css';
import { parseDocument } from './importer.js';
import { PackedAudioPlayer } from './audio-player.js';
import { OnlineTtsProvider } from './online-tts.js';
import { onlineConsent } from './online-consent.js';
import { TTS_ENDPOINT } from './online-config.js';
import { NATURAL_VOICES, bookVoices, canonicalVoiceId } from './voices.js';
import { parseAudioPackage } from './audio-package.js';
import { BookStore, readSettings, writeSettings } from './storage.js';
import { samples } from './sample.js';

const icons = {
 book: '<path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14"/>',
 grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 headphones: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
 plus: '<path d="M12 5v14M5 12h14"/>', upload: '<path d="m8 8 4-4 4 4M12 4v12M4 15v5h16v-5"/>',
 search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
 arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', left: '<path d="m14 6-6 6 6 6"/>',
 play: '<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke-width="0"/>', pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
 prev: '<path d="M5 5v14M19 5 8 12l11 7Z" fill="currentColor"/>', next: '<path d="M19 5v14M5 5l11 7-11 7Z" fill="currentColor"/>',
 list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
 settings: '<path d="M4 7h5m5 0h6M4 17h10m5 0h1"/><circle cx="11.5" cy="7" r="2.5"/><circle cx="16.5" cy="17" r="2.5"/>',
 close: '<path d="m6 6 12 12M6 18 18 6"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
 more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
 sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
 moon: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 volume: '<path d="m11 4-6 5H2v6h3l6 5ZM15 8c3 2 3 6 0 8M18 4c6 4 6 12 0 16"/>', trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
 check: '<path d="m5 12 4 4L19 6"/>', leaf: '<path d="M19 3C8 2 3 6 4 13c1 7 12 7 15-10ZM5 20 15 9"/>',
 info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.book}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const app = document.querySelector('#app');
const store = new BookStore();
const ttsEndpoint = import.meta.env.VITE_TTS_ENDPOINT || TTS_ENDPOINT;
let consentStorage;
try { consentStorage = globalThis.localStorage; } catch { consentStorage = null; }
const speechConsent = onlineConsent(ttsEndpoint, consentStorage);
const provider = new OnlineTtsProvider({ endpoint: ttsEndpoint, canGenerate: endpoint => {
  if (endpoint !== ttsEndpoint) return false;
  if (!speechConsent.accepted) { openModal('online-consent'); return false; }
  return true;
} });
const player = new PackedAudioPlayer({ store, provider });
let settings = readSettings();
let books = [], activeId = '', view = 'library', filter = 'all', query = '', modal = null;
let storageAvailable = true, importing = false, timer, sleepDeadline = 0, toastTimer, wakeLock;
let manualReading = false, readingScrollFrame = 0;
let renderedChapter = -1;
const deletingIds = new Set();
const activeBook = () => books.find(book => book.id === activeId);
const chapterFor = (book, position = book.position) => book.chapters.reduce((current, chapter, i) => chapter.index <= position ? i : current, 0);
const chapterName = book => book.chapters[chapterFor(book)]?.title || '正文';
const progress = book => book.paragraphs.length < 2 ? 0 : Math.round(book.position / (book.paragraphs.length - 1) * 100);
const count = n => n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n.toLocaleString()} 字`;
const sameText = (a, b) => a.paragraphs.length === b.paragraphs.length && a.paragraphs.every((p, i) => p.text === b.paragraphs[i].text);
function loadBook(book) { player.setBook(book, book.position); player.setVoice(settings.audioVoiceId); }

function toast(message) {
  const target = document.querySelector('#toast');
  target.textContent = message; target.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => target.classList.remove('visible'), 4000);
}
function cover(book, cls = '') {
  return `<div class="book-cover cover-${book.cover % 4} ${cls}" aria-hidden="true"><span class="cover-kicker">纸 间 · 故 事 集</span><span class="cover-title">${esc(book.title)}</span><span class="cover-landscape"><i></i><i></i><i></i></span><span class="cover-footer">${book.sample ? '一段慢下来的时光' : '私 藏 的 文 字'}</span></div>`;
}
function render() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--reading-size', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--reading-line', settings.lineHeight);
  document.documentElement.dataset.font = settings.fontFamily;
  const book = activeBook();
  app.innerHTML = `<div class="app-shell ${view === 'reader' ? 'reading-shell' : ''}">
    <aside class="sidebar"><a href="#" class="brand" data-action="nav" data-view="library"><span class="brand-icon">${icon('book')}</span><span>纸间<small>让故事陪在身边</small></span></a>
      <span class="nav-caption">我的空间</span><nav class="main-nav" aria-label="主导航">${[['library','grid','我的书架'],['reader','book','沉浸阅读'],['listen','headphones','随心听书']].map(([key,i,label]) => `<button class="nav-item ${view === key ? 'active' : ''}" data-action="nav" data-view="${key}">${icon(i)}<span>${label}</span>${view === key ? '<i></i>' : ''}</button>`).join('')}</nav>
      <button class="sidebar-import" data-action="import">${icon('plus')} 导入我的小说</button>
      <div class="sidebar-bottom"><div class="small-flower">✳</div><p>一页文字，一段陪伴。<br>把喜欢的故事，留在身边。</p><button class="help-link" data-action="help">${icon('info')} 使用小指南</button><span class="local-note">${icon('shield')} 书架保存在本机</span></div>
    </aside>
    <main class="main-content" id="main-content"><header class="topbar"><span class="topbar-label">${view === 'library' ? '我的书架 <span>/</span> 每个故事，都值得被听见' : `${view === 'reader' ? '沉浸阅读' : '随心听书'} <span>/</span> ${esc(book?.title || '')}`}</span><button class="local-badge" data-action="help">${icon('shield')} 私享阅读空间</button><span class="mobile-brand">${icon('book')} 纸间</span><button class="mobile-import icon-button" data-action="import" aria-label="导入小说">${icon('plus')}</button></header><div id="view-content">${view === 'library' ? libraryHTML() : view === 'reader' ? readerHTML() : listenHTML()}</div></main>
    <nav class="mobile-nav" aria-label="手机导航">${[['library','grid','书架'],['reader','book','阅读'],['listen','headphones','听书']].map(([key,i,label]) => `<button class="${view === key ? 'active' : ''}" data-action="nav" data-view="${key}">${icon(i)}<span>${label}</span></button>`).join('')}</nav>
    ${playerHTML()}
  </div><div id="modal-root"></div>`;
  renderedChapter = book ? chapterFor(book) : -1;
  updatePlayer();
}

function libraryHTML() {
  const book = activeBook();
  return `<div class="library-page"><section class="welcome-hero"><div class="hero-copy"><span class="eyebrow"><span></span> YOUR PRIVATE READING CORNER</span><h1>把字里行间，<br>读给你听<span class="hero-dot">。</span></h1><p>有些故事，只想分享给最亲近的人。<br>在这里，安心阅读，也可以闭上眼睛听。</p><button class="button primary" data-action="import">${icon('plus')} 导入你的第一本故事 ${icon('arrow')}</button><small>支持 Word · Markdown · TXT · 听书包</small></div><div class="hero-art" aria-hidden="true"><div class="art-sun"></div><div class="art-orbit"></div><svg viewBox="0 0 450 320" class="book-art"><defs><linearGradient id="page" x2="1" y2="1"><stop stop-color="#fffdf5"/><stop offset="1" stop-color="#e6e4d4"/></linearGradient></defs><ellipse cx="230" cy="272" rx="161" ry="18" fill="#446653" opacity=".1"/><path d="m52 163 168 46 176-83-1 100-170 76-172-57Z" fill="#3d5b4e"/><path d="m62 156 158 43 165-79-1 99-160 73-162-54Z" fill="#c8cbb6"/><path d="M220 199c-42-41-96-61-156-64v95c60 2 112 23 160 55Z" fill="url(#page)"/><path d="M220 199c40-53 97-81 165-84v94c-70 8-119 29-161 76Z" fill="#faf9ee"/><path d="M220 199v75" stroke="#d2d4c3" stroke-width="3"/><g fill="none" stroke="#c6ccbb" stroke-width="3"><path d="M83 159c44 6 81 20 112 40M83 176c44 6 81 20 112 40M83 193c44 6 81 20 112 40M250 198c30-31 66-49 108-57M250 215c30-31 66-49 108-57M250 232c30-31 66-49 108-57"/></g><path d="m281 162 14-8v64l-8-6-9 12Z" fill="#bb7959"/><path d="M114 104c-1-34-22-46-34-40-5 23 12 44 34 40M116 108c24-12 29-35 18-46-24 10-31 25-18 46M335 84c14-30 4-51-12-49-12 18-6 39 12 49" fill="#8f9c7b"/><path d="m104 121 12-13M334 90l2-15" fill="none" stroke="#667e65" stroke-width="2"/></svg><span class="art-caption">字有温度，声有回响</span><span class="art-spark spark-one">✦</span><span class="art-spark spark-two">✧</span></div></section>
    ${book ? `<section class="continue-section"><div class="continue-cover cover-${book.cover % 4}">${icon('book')}</div><div class="continue-info"><span class="eyebrow">接着上次的故事</span><h3>${esc(book.title)}</h3><p>${esc(chapterName(book))}<span>·</span>已读 ${progress(book)}%</p></div><div class="continue-progress"><div class="thin-track"><i style="width:${progress(book)}%"></i></div><span>故事一直在，等你翻开</span></div><button class="button subtle" data-action="nav" data-view="reader">继续阅读 ${icon('arrow')}</button></section>` : ''}
    <section class="books-section"><div class="section-heading"><div><h2>我的书架 <span>${books.length}</span></h2><p>收藏文字，也收藏片刻安宁</p></div><label class="search-field">${icon('search')}<input id="book-search" type="search" placeholder="找一本想读的书" aria-label="搜索书架" value="${esc(query)}" /></label></div><div class="shelf-toolbar"><div class="shelf-tabs" role="group" aria-label="书架筛选"><button class="${filter === 'all' ? 'active' : ''}" data-action="filter" data-filter="all">全部书籍</button><button class="${filter === 'mine' ? 'active' : ''}" data-action="filter" data-filter="mine">我导入的</button><button class="${filter === 'recent' ? 'active' : ''}" data-action="filter" data-filter="recent">最近阅读</button></div><span>按最近阅读排序</span></div><div class="book-grid" id="book-grid">${bookGridHTML()}</div></section>
    <div class="library-footnote">${icon('leaf')} 不必赶路，慢慢读，慢慢听。</div></div>`;
}
function bookGridHTML() {
  const list = [...books].sort((a,b) => b.updatedAt - a.updatedAt).filter(book => (filter !== 'mine' || !book.sample) && (filter !== 'recent' || book.position > 0) && book.title.toLowerCase().includes(query.toLowerCase()));
  return list.map(book => `<article class="book-card"><button class="cover-button" data-action="open-book" data-id="${esc(book.id)}" aria-label="阅读${esc(book.title)}">${cover(book)}<span class="cover-open">${icon('book')} 翻开故事</span></button><div class="book-card-heading"><button data-action="open-book" data-id="${esc(book.id)}"><h3>${esc(book.title)}</h3></button><button class="icon-button book-more" data-action="book-menu" data-id="${esc(book.id)}" aria-label="${esc(book.title)}的更多操作">${icon('more')}</button></div><p class="book-meta">${book.sample ? '<span class="sample-tag">体验读物</span>' : `<span class="format-tag">${esc(book.audioPack ? '听书包' : book.format.toUpperCase())}</span>`}<span>${count(book.wordCount)} · ${book.chapters.length} 章</span></p><div class="book-progress"><div class="thin-track"><i style="width:${progress(book)}%"></i></div><span>${book.position ? `已读 ${progress(book)}%` : '还未翻开'}</span></div></article>`).join('') + `${!list.length && (query || filter !== 'all') ? '<div class="shelf-empty">'+icon('book')+'<p>这里还没有找到故事</p><small>换个关键词，或导入一本自己的小说</small></div>' : ''}<button class="import-card" data-action="import"><span class="import-icon">${icon('plus')}</span><strong>下一个故事，由你带来</strong><span>导入亲手写下的文字<br>让牵挂的人，读得到，也听得见</span><small>Word / Markdown / TXT / 听书包</small></button>`;
}
function readerHTML() {
  const book = activeBook(); if (!book) return emptyHTML();
  const c = chapterFor(book), start = book.chapters[c]?.index || 0, end = book.chapters[c + 1]?.index ?? book.paragraphs.length;
  return `<div class="reader-page"><div class="reader-toolbar"><button class="text-button" data-action="nav" data-view="library">${icon('left')} 返回书架</button><div><button class="text-button" data-action="chapters">${icon('list')} 目录</button><button class="text-button" data-action="reading-settings">${icon('settings')} <span>阅读设置</span></button></div></div><div class="reading-hint">${icon('headphones')} 轻点任意段落，即可从这里开始听<span class="playback-status" role="status" aria-live="polite"></span></div><article class="reading-article" aria-label="小说正文"><div class="chapter-eyebrow">${esc(book.title)} <span>·</span> 第 ${c + 1} / ${book.chapters.length} 章</div><h1>${esc(book.chapters[c]?.title || book.title)}</h1>${book.paragraphs.slice(start,end).map((p, i) => p.type === 'heading' && i === 0 ? '' : `<${p.type === 'heading' ? 'h2' : 'p'} class="reading-paragraph ${book.position === start+i ? 'selected' : ''}" data-index="${start + i}" tabindex="0" role="button" aria-label="从这段开始听：${esc(p.text.slice(0,22))}">${esc(p.text)}</${p.type === 'heading' ? 'h2' : 'p'}>`).join('')}<div class="chapter-end"><span>✦</span><p>${c === book.chapters.length-1 ? '读到这里，愿故事仍有回响' : '下一章，还有新的故事'}</p></div><div class="chapter-navigation"><button class="button subtle" data-action="prev-chapter" ${c === 0 ? 'disabled' : ''}>${icon('left')} 上一章</button><button class="button primary" data-action="next-chapter" ${c >= book.chapters.length-1 ? 'disabled' : ''}>下一章 ${icon('arrow')}</button></div></article></div>`;
}
function listenHTML() {
  const book = activeBook(); if (!book) return emptyHTML();
  return `<div class="listen-page"><div class="listen-topline"><span class="eyebrow">CLOSE YOUR EYES, OPEN A STORY</span><button class="text-button" data-action="chapters">${icon('list')} 章节目录</button></div><div class="listening-layout"><div class="listen-cover-wrap">${cover(book, 'listen-cover')}<div class="cover-shadow"></div><span class="listen-cover-caption">让文字有声音，让陪伴更近一点</span></div><div class="listen-detail"><span class="listening-label">${icon('headphones')} 此刻，听一个故事</span><h1>${esc(book.title)}</h1><button class="current-chapter" data-action="chapters"><span id="listen-chapter">${esc(chapterName(book))}</span>${icon('list')}</button><div class="quote-card"><span>“</span><p id="listen-quote">${esc(book.paragraphs[book.position]?.text)}</p><button class="text-button" data-action="nav" data-view="reader">回到这一页 ${icon('arrow')}</button></div><div class="listen-progress"><input class="position-slider" aria-label="听书进度" type="range" min="0" max="${book.paragraphs.length-1}" value="${book.position}"/><div><span class="position-label">第 ${book.position+1} / ${book.paragraphs.length} 段</span><span>${count(book.wordCount)}</span></div></div><div class="large-controls"><button class="icon-button" data-action="prev-paragraph" aria-label="上一段">${icon('prev')}</button><button class="large-play" data-action="play" aria-label="开始朗读">${icon('play')}</button><button class="icon-button" data-action="next-paragraph" aria-label="下一段">${icon('next')}</button></div><div class="listen-tools"><button data-action="audio-settings">${icon('volume')}<span class="rate-label">${settings.rate}× 语速 / 音色</span></button><button data-action="sleep">${icon('clock')}<span class="sleep-label">定时停止</span></button></div><p class="playback-status" role="status" aria-live="polite"></p><p class="listen-note">${icon('info')} ${book.audioPack ? '听书包可离线播放；iPhone 锁屏收听请以实际效果为准。' : '首次生成需联网；已听音频保存在本机，可重复收听。'}</p></div></div></div>`;
}
function emptyHTML() { return `<div class="empty-page">${icon('book')}<h2>先选一本故事吧</h2><p>从书架翻开一本书，或导入自己的文档。</p><button class="button primary" data-action="import">${icon('plus')} 导入小说</button></div>`; }
function playerHTML() {
  const book = activeBook(); if (!book || view === 'listen') return '';
  return `<section class="player-bar" aria-label="朗读控制"><button class="player-book" data-action="nav" data-view="listen"><span class="player-cover cover-${book.cover % 4}">${icon('book')}</span><span><strong>${esc(book.title)}</strong><small class="player-chapter">${esc(chapterName(book))}</small><small class="playback-status" role="status" aria-live="polite"></small></span></button><div class="player-center"><div class="player-buttons"><button class="icon-button" data-action="prev-paragraph" aria-label="上一段">${icon('prev')}</button><button class="play-button" data-action="play" aria-label="开始朗读">${icon('play')}</button><button class="icon-button" data-action="next-paragraph" aria-label="下一段">${icon('next')}</button></div><div class="player-progress"><span class="position-label">第 ${book.position+1} 段</span><input class="position-slider" type="range" min="0" max="${book.paragraphs.length-1}" value="${book.position}" aria-label="朗读进度"/><span class="percent-label">${progress(book)}%</span></div></div><div class="player-options"><button data-action="audio-settings"><span class="rate-label">${settings.rate}×</span><small>语速 / 音色</small></button><button data-action="sleep" aria-label="定时停止">${icon('clock')}<small class="sleep-label">定时</small></button><button data-action="chapters" aria-label="章节目录">${icon('list')}<small>目录</small></button></div></section>`;
}

function selectBook(id, destination = 'reader') {
  const next = books.find(book => book.id === id); if (!next) return;
  if (activeId !== id) { activeId = id; loadBook(next); }
  next.updatedAt = Date.now(); persistBook(next); navigate(destination);
}
function navigate(destination) { view = destination; modal = null; manualReading = false; render(); window.scrollTo({top:0}); if (view === 'reader') requestAnimationFrame(() => scrollToPosition(false)); }
function persistBook(book) {
  if (!storageAvailable || deletingIds.has(book.id)) return;
  store.put({...book}).catch(error => {storageAvailable=false; toast(error.message + '，本次进度仅保留到页面关闭。');});
}
function savePosition() { const book = activeBook(); if (book) persistBook(book); }
function seek(index, autoplay = player.active) {
  const book = activeBook(); if (!book || deletingIds.has(book.id)) return;
  player.seek(Math.max(0,Math.min(index,book.paragraphs.length-1)),{autoplay});
}
function playBook(toggle = false) {
  if (!activeBook() || deletingIds.has(activeId)) return false;
  if (toggle && player.active) { player.pause(); return true; }
  if(!player.supported){toast('当前浏览器无法播放音频，请使用 Safari 或最新版 Chrome。');return false;}
  player.play(); return true;
}
function scrollToPosition(smooth = true) { const selected = document.querySelector(`.reading-paragraph[data-index="${activeBook()?.position}"]`); selected?.scrollIntoView({behavior:smooth?'smooth':'instant',block:'center'}); }
function updatePosition() {
  const book = activeBook(); if (!book) return;
  if (view === 'reader' && chapterFor(book) !== renderedChapter) { document.querySelector('#view-content').innerHTML = readerHTML(); renderedChapter=chapterFor(book); window.scrollTo({top:0}); }
  document.querySelectorAll('.reading-paragraph').forEach(p => p.classList.toggle('selected',Number(p.dataset.index) === book.position));
  document.querySelectorAll('.position-slider').forEach(input => {input.value=book.position; input.style.setProperty('--progress',progress(book)+'%');});
  document.querySelectorAll('.position-label').forEach(el => el.textContent = view === 'listen' ? `第 ${book.position+1} / ${book.paragraphs.length} 段` : `第 ${book.position+1} 段`);
  document.querySelectorAll('.percent-label').forEach(el => el.textContent=progress(book)+'%');
  document.querySelectorAll('.player-chapter, #listen-chapter').forEach(el => el.textContent=chapterName(book));
  const quote = document.querySelector('#listen-quote'); if (quote) quote.textContent=book.paragraphs[book.position].text;
  if (view === 'reader' && player.status === 'playing') scrollToPosition();
}
function updatePlayer() {
  const playing = player.active;
  document.querySelectorAll('[data-action="play"]').forEach(button => {button.innerHTML=icon(playing?'pause':'play'); button.setAttribute('aria-label',player.status==='loading'?'取消生成声音':playing?'暂停朗读':'开始朗读'); button.setAttribute('aria-pressed',String(playing)); button.setAttribute('aria-busy',String(player.status==='loading'));});
  document.querySelectorAll('.playback-status').forEach(el => { el.textContent = player.status==='loading'?'正在准备声音… 可点暂停取消':player.status==='playing'?'正在朗读':player.status==='error'?'朗读未成功，请点播放重试':''; });
  document.body.classList.toggle('is-playing',playing);
  document.querySelectorAll('.rate-label').forEach(el=>el.textContent = view==='listen'?`${settings.rate}× 语速 / 音色`:`${settings.rate}×`);
  updatePosition(); updateSleepLabels();
}
player.addEventListener('positionchange', event => { const book=activeBook(); if(!book)return; book.position=event.detail.index; book.updatedAt=Date.now(); updatePosition(); savePosition(); });
player.addEventListener('cachewarning', event => toast(event.detail.message));
player.addEventListener('statechange', event => { updatePlayer(); if(event.detail.error) toast(event.detail.error); if(player.status==='ended') toast('这本故事听完啦，愿你有一段好时光。'); manageWakeLock(); });
async function manageWakeLock() { try {if(player.active && document.visibilityState==='visible' && 'wakeLock' in navigator){if(!wakeLock || wakeLock.released)wakeLock=await navigator.wakeLock.request('screen');}else{await wakeLock?.release();wakeLock=null;}}catch{} }

function modalShell(title, subtitle, content, wide=false) { return `<div class="modal-backdrop"><section class="sheet ${wide?'wide-sheet':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="sheet-handle"></div><header class="sheet-header"><div><h2 id="modal-title">${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close')}</button></header><div class="sheet-body">${content}</div></section></div>`; }
function audioSettingsHTML(book) {
  const rate = `<div class="setting-row"><label for="speech-rate">朗读语速</label><output id="speech-rate-output">${settings.rate}×</output></div><input id="speech-rate" type="range" min="0.5" max="2" step="0.1" value="${settings.rate}"/><div class="range-legend"><span>慢一点 0.5×</span><span>正常 1×</span><span>快一点 2×</span></div>`;
  const available = bookVoices(book);
  const ready = available.length > 0;
  const selected = ready ? canonicalVoiceId(player.voiceId) : settings.audioVoiceId;
  return `${rate}<div class="setting-row"><span>中文自然音色</span><small>${ready?'听书包 · 离线播放':'固定四种音色 · 联网生成'}</small></div><div class="voice-list">${NATURAL_VOICES.map(voice => {const included=available.some(item=>item.id===voice.id);return `<label class="voice-option ${ready&&!included?'voice-unavailable':''}"><input type="radio" name="audio-voice" value="${voice.id}" ${selected===voice.id?'checked':''} ${ready&&!included?'disabled':''}/><span><strong>${voice.label}</strong><small>${included?'中文自然语音 · 本机音频':ready?'本听书包未包含此音色':'点播放后逐段生成 · 已听音频保存在本机'}</small></span></label>`;}).join('')}</div><p class="setting-note">${ready?'切换音色会从当前段落重新播放；听书包内的音频可离线收听。请保留原始听书包。':'导入普通文档后，选好音色即可点播放。首次生成需要联网，并将当前朗读段落经 Cloudflare 服务发送到 Microsoft Edge 在线语音服务；仅打开书籍或在暂停时切换音色不会发送正文。免费接口可能暂时不可用。'}</p><button class="button primary full-width" data-action="preview-voice">${icon('volume')} 从当前段落试听</button>${!ready&&speechConsent.accepted?'<button class="text-button full-width" data-action="revoke-online">停止使用在线生成</button>':''}<button class="button subtle full-width" data-action="audio-guide">${icon('info')} 离线听书包（可选）</button>`;
}
let lastFocus;
function openModal(type,id) {
  if(!modal) lastFocus=document.activeElement;
  modal=type; const book=activeBook(); let content='',title='',subtitle='',wide=false;
  if(type==='chapters') { if(!book) return; title='章节目录'; subtitle=`${esc(book.title)} · 共 ${book.chapters.length} 章`; content=`<div class="chapter-list">${book.chapters.map((chapter,i)=>`<button data-action="goto-chapter" data-index="${chapter.index}" class="${chapterFor(book)===i?'active':''}"><span class="chapter-number">${String(i+1).padStart(2,'0')}</span><span>${esc(chapter.title)}</span>${chapterFor(book)===i?icon('volume'):icon('left','chapter-arrow')}</button>`).join('')}</div>`; }
  if(type==='reading-settings') { title='阅读设置'; subtitle='调成眼睛喜欢的样子'; content=`<div class="setting-row"><label for="font-size">文字大小</label><output id="font-size-output">${settings.fontSize}px</output></div><div class="font-slider"><span>小</span><input id="font-size" type="range" min="16" max="32" step="1" value="${settings.fontSize}"/><span>大</span></div><div class="setting-row"><span>阅读字体</span></div><div class="segmented">${[['serif','宋体 · 有书卷气'],['sans','黑体 · 清晰易读']].map(([value,label])=>`<button data-action="font" data-value="${value}" class="${settings.fontFamily===value?'active':''}">${label}</button>`).join('')}</div><div class="setting-row"><span>页面颜色</span></div><div class="theme-options">${[['paper','sun','暖纸'],['sage','leaf','护眼绿'],['dark','moon','夜间']].map(([value,i,label])=>`<button data-action="theme" data-value="${value}" class="theme-${value} ${settings.theme===value?'active':''}">${icon(i)} ${label}${settings.theme===value?icon('check'):''}</button>`).join('')}</div><div class="setting-row"><label for="line-height">行间距离</label><output id="line-height-output">${settings.lineHeight.toFixed(2)}</output></div><input id="line-height" type="range" min="1.6" max="2.4" step="0.05" value="${settings.lineHeight}"/>`; }
  if(type==='audio-settings') { title='听书设置'; subtitle='找到舒服的声音与节奏'; content=audioSettingsHTML(book); }
  if(type==='online-consent') { title='使用在线自然语音'; subtitle='晓晓、晓伊、云希、云扬'; content=`<p class="delete-message">点「同意并播放」后，当前段落及接下来连续朗读的段落会经 Cloudflare 语音网关发送到 Microsoft Edge 在线语音服务，生成音频后保存在此设备。网关代码不保存小说正文或音频。书架不会公开到 GitHub。</p><p class="setting-note">服务地址：${esc(ttsEndpoint ? new URL(ttsEndpoint).host : '尚未连接')}。打开书籍、阅读、暂停时选音色不会发送文字。可在听书设置中停止在线生成；清除网站数据会删除本机音频。免费非官方语音接口可能中断。</p><div class="confirm-buttons"><button class="button subtle" data-action="close-modal">暂不使用</button><button class="button primary" data-action="allow-online">同意并播放</button></div>`; }
  if(type==='audio-guide') { title='生成四音色听书包'; subtitle='晓晓、晓伊、云希、云扬 · 导入后离线听'; content=`<div class="help-grid"><div><span class="help-number">01</span><h3>你来生成</h3><p>在电脑上的项目文件夹打开 scripts，双击「生成听书包.cmd」，把 .md、.txt 或 .docx 小说拖进窗口后按回车。默认生成晓晓、晓伊、云希、云扬四种声音，输出的 .zjbook 和原文档放在同一个文件夹。</p></div><div><span class="help-number">02</span><h3>发给妈妈</h3><p>把 .zjbook 文件私下发给妈妈。妈妈先保存到 iPhone「文件」，再在纸间点「导入小说」，选择这个听书包。一本书内可阅读、从任意段开始听、切换音色和语速。</p></div></div><div class="notice">${icon('info')} 生成自然人声时，小说文字会发送给第三方在线语音服务；妈妈导入听书包时不上传小说。免费语音接口可能不稳定，听书包可能较大，请保留原文件。</div>`; wide=true; }
  if(type==='sleep') { title='定时停止'; subtitle='听着故事，也能安心休息'; content=`<div class="sleep-options">${[0,15,30,60].map(minutes=>`<button data-action="set-sleep" data-value="${minutes}" class="${settings.sleepMinutes===minutes?'active':''}">${icon(minutes?'clock':'moon')}<span>${minutes?`${minutes} 分钟后`:'不设置定时'}</span>${settings.sleepMinutes===minutes?icon('check'):''}</button>`).join('')}</div><p class="setting-note">从设置时开始计时，到时自动暂停朗读。</p>`; }
  if(type==='help') { title='你好，欢迎来到纸间'; subtitle='把故事交给文字，也交给声音'; wide=true; content=`<div class="help-grid"><div><span class="help-number">01</span><h3>带来你的故事</h3><p>点「导入小说」，从 iPhone「文件」中选择 .docx、.md 或 .txt 文档。微信收到的文件可以先「存储到文件」。旧版 .doc 请在 Word 中另存为 .docx。</p></div><div><span class="help-number">02</span><h3>想读就读，想听就听</h3><p>导入普通文档后，选好音色点播放，或轻点任意段落开始听。首次同意后会联网逐段生成，已生成的音频保存在本机。听书设置固定提供晓晓、晓伊、云希、云扬四种中文自然音色，并可调整语速。</p></div><div><span class="help-number">03</span><h3>放到 iPhone 主屏幕</h3><p>用 Safari 打开本网站，点「分享 → 添加到主屏幕」。成功在线打开过后，已导入的内容可离线阅读；已成功缓存的音频及听书包可离线收听，没生成的段落仍需联网。</p></div><div><span class="help-number">04</span><h3>了解文字的发送方式</h3><p>书架保存在手机。在线朗读经 Cloudflare 网关将当前和接下来播放的段落发送到 Microsoft Edge 语音服务；导入或阅读文档不会自动上传。每台手机的书架独立；清除网站数据、无痕浏览或删除应用可能使本地内容丢失，请保留原稿和听书包。</p></div></div><div class="notice">${icon('info')} 这里固定使用四种中文自然音色。免费在线接口可能暂时不可用；iPhone 首次音频准备好后若提示再点播放，请再点一次。锁屏及后台续播请先在实际手机试播。</div><p class="setting-note">这里的《山海来信》《晚风有信》是内置体验短篇。普通文档单个最大 20 MB；听书包单个最大 300 MB，较长小说可拆卷。支持按标题自动生成目录。</p>`; }
  if(type==='book-menu') { const target=books.find(b=>b.id===id); if(!target)return; title=esc(target.title); subtitle=`${count(target.wordCount)} · ${target.chapters.length} 章`; content=`<div class="book-actions"><button data-action="open-book" data-id="${esc(id)}">${icon('book')} 翻开阅读 ${icon('arrow')}</button><button data-action="listen-book" data-id="${esc(id)}">${icon('headphones')} 从上次的位置听 ${icon('arrow')}</button><button class="danger" data-action="confirm-delete" data-id="${esc(id)}">${icon('trash')} 从本机书架移除</button></div>`; }
  if(type==='confirm-delete') { const target=books.find(b=>b.id===id); if(!target)return; title='移除这本故事？'; subtitle='原始文档不受影响，重新导入可以再次阅读。'; content=`<p class="delete-message">《${esc(target.title)}》的本机阅读进度也会一并移除。</p><div class="confirm-buttons"><button class="button subtle" data-action="close-modal">保留</button><button class="button danger-button" data-action="delete-book" data-id="${esc(id)}">确认移除</button></div>`; }
  document.querySelector('#modal-root').innerHTML=modalShell(title,subtitle,content,wide); document.body.classList.add('modal-open');
  requestAnimationFrame(()=>document.querySelector('.sheet-header button')?.focus());
}
function closeModal(){modal=null;document.querySelector('#modal-root').innerHTML='';document.body.classList.remove('modal-open');lastFocus?.focus();}
function applySettings(){settings=writeSettings(settings);document.documentElement.dataset.theme=settings.theme;document.documentElement.dataset.font=settings.fontFamily;document.documentElement.style.setProperty('--reading-size',settings.fontSize+'px');document.documentElement.style.setProperty('--reading-line',settings.lineHeight);}
function setSleep(minutes) { clearTimeout(timer); settings.sleepMinutes=minutes; writeSettings(settings); sleepDeadline=minutes?Date.now()+minutes*60000:0; if(minutes)timer=setTimeout(checkSleep,minutes*60000); updateSleepLabels(); }
function checkSleep(){if(sleepDeadline && Date.now()>=sleepDeadline){player.pause();setSleep(0);toast('定时时间到了，已为你暂停朗读。');}}
function updateSleepLabels(){document.querySelectorAll('.sleep-label').forEach(el=>el.textContent=sleepDeadline?`${Math.max(1,Math.ceil((sleepDeadline-Date.now())/60000))} 分钟`:view==='listen'?'定时停止':'定时');}

async function importFiles(files) {
  if(importing)return; importing=true; let imported=0,lastId,errors=[];
  toast('正在整理你的故事…');
  for(const file of files) {
    try {
      const packed = /\.zjbook$/i.test(file.name);
      if (packed && !storageAvailable) throw new Error('保存空间不可用，请使用 Safari 普通浏览模式打开后再导入听书包。');
      const parsed = packed ? await parseAudioPackage(file) : null;
      const result = parsed?.book || await parseDocument(file);
      const duplicate = books.find(b => sameText(b, result) && (packed || b.fileName === result.fileName));
      if (duplicate && !packed) { lastId = duplicate.id; continue; }
      const book = {...result,id:duplicate?.id || crypto.randomUUID?.() || `book-${Date.now()}-${Math.random().toString(36).slice(2)}`,position:duplicate?.position || 0,cover:duplicate?.cover ?? books.length%4,sample:false,importedAt:duplicate?.importedAt || Date.now(),updatedAt:Date.now()};
      if(packed) {
        player.pause();
        await store.putAudioPack(book, parsed.audioBlobs);
        try { await navigator.storage?.persist?.(); } catch {}
      } else if(storageAvailable) await store.put(book);
      books = books.filter(b => b.id !== book.id);
      books.unshift(book);
      if (activeId === book.id) loadBook(book);
      lastId=book.id; imported++;
    } catch(error) { errors.push(`${file.name}：${error.message}`); }
  }
  importing=false; document.querySelector('#file-input').value='';
  if(lastId){selectBook(lastId, books.find(b=>b.id===lastId)?.audioPack?'listen':'reader');toast(imported?`已导入 ${imported} 本故事${storageAvailable?'，内容和进度已保存在本机':'；本次仅临时保存，请保留原稿'}`:'这本故事已经在书架中，为你打开了');}
  if(errors.length){openImportErrors(errors);}
}
function openImportErrors(errors){modal='import-errors';document.querySelector('#modal-root').innerHTML=modalShell('有些文件没有导入','已成功导入的文档仍在书架中。',`<div class="import-errors">${errors.map(e=>`<p>${esc(e)}</p>`).join('')}</div><button class="button primary full-width" data-action="close-modal">知道了</button>`);document.body.classList.add('modal-open');document.querySelector('.sheet-header button')?.focus();}

document.addEventListener('click', async event => {
  if(event.target.classList.contains('modal-backdrop')){closeModal();return;}
  const paragraph=event.target.closest('.reading-paragraph'); if(paragraph && !window.getSelection()?.toString()){seek(Number(paragraph.dataset.index),true);return;}
  const button=event.target.closest('[data-action]');if(!button)return;event.preventDefault();const action=button.dataset.action,book=activeBook();
  if(action==='nav'){navigate(button.dataset.view);document.body.classList.remove('modal-open');}
  if(action==='import'){if(!importing)document.querySelector('#file-input').click();}
  if(action==='open-book'||action==='listen-book'){closeModal();selectBook(button.dataset.id,action==='listen-book'?'listen':'reader');if(action==='listen-book')playBook();}
  if(action==='filter'){filter=button.dataset.filter;render();}
  if(action==='play')playBook(true);
  if(action==='allow-online'){speechConsent.allow();closeModal();player.play();}
  if(action==='revoke-online'){player.pause();speechConsent.revoke();openModal('audio-settings');toast('已停止在线生成；本机已有音频仍保留。');}
  if(action==='prev-paragraph')seek((book?.position||0)-1);
  if(action==='next-paragraph')seek((book?.position||0)+1);
  if(action==='prev-chapter'||action==='next-chapter'){if(book){const c=chapterFor(book)+(action==='next-chapter'?1:-1);if(book.chapters[c]){seek(book.chapters[c].index);window.scrollTo({top:0,behavior:'smooth'});}}}
  if(['chapters','reading-settings','audio-settings','audio-guide','sleep','help','book-menu','confirm-delete'].includes(action))openModal(action,button.dataset.id);
  if(action==='close-modal')closeModal();
  if(action==='goto-chapter'){seek(Number(button.dataset.index));closeModal();if(view==='reader')scrollToPosition();}
  if(action==='font'){settings.fontFamily=button.dataset.value;applySettings();openModal('reading-settings');}
  if(action==='theme'){settings.theme=button.dataset.value;applySettings();openModal('reading-settings');}
  if(action==='preview-voice'){if(playBook())toast('正在用所选自然音色朗读当前段落');}
  if(action==='set-sleep'){setSleep(Number(button.dataset.value));closeModal();toast(settings.sleepMinutes?`将在 ${settings.sleepMinutes} 分钟后停止朗读`:'已关闭定时停止');}
  if(action==='delete-book'){const id=button.dataset.id;if(deletingIds.has(id))return;deletingIds.add(id);if(activeId===id)player.stop();try{if(storageAvailable)await store.delete(id);if(activeId===id){books=books.filter(b=>b.id!==id);activeId=books[0]?.id||'';if(activeBook())loadBook(activeBook());}else books=books.filter(b=>b.id!==id);closeModal();navigate('library');toast('已从本机书架移除');}catch(error){toast(error.message);}finally{deletingIds.delete(id);}}
});
document.addEventListener('input',event=>{
  const input=event.target;
  if(input.id==='book-search'){query=input.value;document.querySelector('#book-grid').innerHTML=bookGridHTML();}
  if(input.id==='font-size'){settings.fontSize=Number(input.value);applySettings();document.querySelector('#font-size-output').textContent=settings.fontSize+'px';}
  if(input.id==='line-height'){settings.lineHeight=Number(input.value);applySettings();document.querySelector('#line-height-output').textContent=settings.lineHeight.toFixed(2);}
  if(input.id==='speech-rate'){document.querySelector('#speech-rate-output').textContent=Number(input.value)+'×';}
});
document.addEventListener('change',event=>{
  const input=event.target;
  if(input.classList.contains('position-slider'))seek(Number(input.value));
  if(input.id==='speech-rate'){settings.rate=Number(input.value);applySettings();player.setRate(settings.rate);updatePlayer();}
  if(input.name==='audio-voice'){settings.audioVoiceId=input.value;applySettings();player.setVoice(settings.audioVoiceId);}
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&modal)closeModal();
  if((event.key==='Enter'||event.key===' ')&&event.target.classList.contains('reading-paragraph')){event.preventDefault();seek(Number(event.target.dataset.index),true);}
  if(event.key==='Tab'&&modal){const controls=[...document.querySelectorAll('.sheet button:not(:disabled),.sheet input,.sheet a')];const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
});
document.querySelector('#file-input').addEventListener('change',event=>importFiles([...event.target.files]));
for (const eventName of ['wheel','touchmove']) window.addEventListener(eventName,()=>{if(view==='reader'&&!modal&&!player.active)manualReading=true;},{passive:true});
window.addEventListener('scroll',()=>{
  if(!manualReading||readingScrollFrame||view!=='reader'||modal||player.active)return;
  readingScrollFrame=requestAnimationFrame(()=>{
    readingScrollFrame=0;
    const paragraphs=[...document.querySelectorAll('.reading-paragraph')];
    const threshold=window.innerHeight*0.32;
    const paragraph=paragraphs.find(element=>element.getBoundingClientRect().bottom>threshold);
    if(paragraph && Number(paragraph.dataset.index)!==activeBook()?.position)seek(Number(paragraph.dataset.index),false);
  });
},{passive:true});
window.addEventListener('pagehide',()=>{if(activeBook())persistBook(activeBook());});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){checkSleep();updateSleepLabels();manageWakeLock();}else if(activeBook())persistBook(activeBook());});
setInterval(updateSleepLabels,30000);

async function init(){
  try{await store.init();books=await store.getAll();let seeded=false;try{seeded=localStorage.getItem('zhijian-seeded')==='yes';}catch{}if(!seeded&&books.length===0){books=samples;for(const book of books)await store.put(book);try{localStorage.setItem('zhijian-seeded','yes');}catch{}}}catch(error){storageAvailable=false;books=samples;setTimeout(()=>toast(error.message+'，当前使用临时书架，请保留原始文档。'),600);}
  activeId=[...books].sort((a,b)=>b.updatedAt-a.updatedAt)[0]?.id||'';
  if(activeBook())loadBook(activeBook());
  player.setRate(settings.rate);
  settings.sleepMinutes=0;writeSettings(settings);render();
  if('serviceWorker' in navigator && import.meta.env.PROD)navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
init();
