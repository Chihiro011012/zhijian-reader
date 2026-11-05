import { canonicalVoiceId } from './voices.js';

const SETTINGS_KEY = 'zhijian-settings-v1';

export const DEFAULT_SETTINGS = Object.freeze({
  fontSize: 22,
  fontFamily: 'serif',
  theme: 'paper',
  lineHeight: 1.95,
  rate: 1,
  audioVoiceId: 'xiaoxiao',
  sleepMinutes: 0,
});

const clamp = (value, min, max, fallback) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

/** Keep only preferences: book text never belongs in localStorage. */
export function normalizeSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    fontSize: Math.round(clamp(source.fontSize, 16, 32, DEFAULT_SETTINGS.fontSize)),
    fontFamily: ['serif', 'sans'].includes(source.fontFamily) ? source.fontFamily : DEFAULT_SETTINGS.fontFamily,
    theme: ['paper', 'sage', 'dark'].includes(source.theme) ? source.theme : DEFAULT_SETTINGS.theme,
    lineHeight: Number(clamp(source.lineHeight, 1.6, 2.4, DEFAULT_SETTINGS.lineHeight).toFixed(2)),
    rate: Number(clamp(source.rate, 0.5, 2, DEFAULT_SETTINGS.rate).toFixed(2)),
    audioVoiceId: canonicalVoiceId(source.audioVoiceId) || DEFAULT_SETTINGS.audioVoiceId,
    sleepMinutes: [0, 15, 30, 60].includes(source.sleepMinutes) ? source.sleepMinutes : 0,
  };
}

function preferenceStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

export function readSettings() {
  try {
    const stored = preferenceStorage()?.getItem(SETTINGS_KEY);
    return normalizeSettings(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Saving preferences is best effort, including in Safari private mode. */
export function writeSettings(settings) {
  const normalized = normalizeSettings(settings);
  try { preferenceStorage()?.setItem(SETTINGS_KEY, JSON.stringify(normalized)); } catch { /* Session settings still work. */ }
  return normalized;
}

function storageError(error, fallback = '无法保存到手机，请检查浏览器的存储权限后重试。') {
  let message = fallback;
  if (error?.name === 'QuotaExceededError') {
    message = '手机可用的存储空间不足，请删除一些书籍或释放手机空间后重试。';
  } else if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') {
    message = '浏览器未允许保存本地书籍，请使用 Safari 普通浏览模式并允许网站存储。';
  } else if (error?.name === 'DataCloneError') {
    message = '这本书的数据无法保存，请重新导入文档。';
  }
  return new Error(message, { cause: error });
}

const timestamp = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Books, including their text and reading position, stay in this browser. */
export class BookStore {
  constructor() {
    this.db = null;
    this.opening = null;
  }

  async init() {
    if (this.db) return this;
    if (this.opening) return this.opening;
    let indexedDB;
    try { indexedDB = globalThis.indexedDB; } catch (error) { throw storageError(error); }
    if (!indexedDB) {
      throw new Error('当前浏览器无法保存本地书籍，请用 Safari 普通浏览模式打开。关闭页面后，本次导入内容可能丢失。');
    }
    this.opening = new Promise((resolve, reject) => {
      let request;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      try { request = indexedDB.open('zhijian-reader', 2); } catch (error) { fail(storageError(error)); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) {
          const audio = db.createObjectStore('audio', { keyPath: 'key' });
          audio.createIndex('bookId', 'bookId', { unique: false });
        }
      };
      request.onerror = () => fail(storageError(request.error, '无法打开本地书架，请刷新页面或使用 Safari 普通浏览模式。'));
      request.onblocked = () => fail(new Error('书架正在被其他页面使用，请关闭其他纸间页面后刷新重试。'));
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        this.db = db;
        db.onversionchange = () => { db.close(); if (this.db === db) this.db = null; };
        resolve(this);
      };
    });
    try { return await this.opening; } finally { this.opening = null; }
  }

  async transaction(mode, operation) {
    await this.init();
    return new Promise((resolve, reject) => {
      let transaction;
      let result;
      let requestError;
      try {
        transaction = this.db.transaction('books', mode);
        const request = operation(transaction.objectStore('books'));
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => { requestError = request.error; };
      } catch (error) {
        // A synchronous request error can happen before the transaction aborts.
        try { transaction?.abort(); } catch { /* Already inactive. */ }
        reject(storageError(error));
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(storageError(transaction.error || requestError));
      transaction.onerror = () => { /* The abort handler reports the final failure. */ };
    });
  }

  async getAll() {
    const books = await this.transaction('readonly', store => store.getAll());
    return books.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt) || timestamp(b.importedAt) - timestamp(a.importedAt));
  }

  async put(book) {
    if (!book || typeof book.id !== 'string' || !book.id) throw new Error('书籍缺少有效的编号，无法保存。');
    await this.transaction('readwrite', store => store.put(book));
    return book;
  }

  async putAudio(bookId, index, blob, voiceId = DEFAULT_SETTINGS.audioVoiceId) {
    if (typeof bookId !== 'string' || !bookId || !Number.isInteger(index) || index < 0 || !canonicalVoiceId(voiceId) || !(blob instanceof Blob)) throw new Error('音频片段数据无效，无法保存。');
    await this.audioTransaction('readwrite', store => store.put({ key: `${bookId}:${voiceId}:${index}`, bookId, voiceId, index, blob }));
  }

  async getAudio(bookId, index, voiceId = DEFAULT_SETTINGS.audioVoiceId) {
    if (typeof bookId !== 'string' || !bookId || !Number.isInteger(index) || index < 0 || !canonicalVoiceId(voiceId)) return null;
    const record = await this.audioTransaction('readonly', store => store.get(`${bookId}:${voiceId}:${index}`));
    return record?.blob || null;
  }

  /** Serialize the existence check with deletion, so a late request cannot orphan audio. */
  async putAudioIfBookExists(bookId, index, blob, voiceId = DEFAULT_SETTINGS.audioVoiceId) {
    if (typeof bookId !== 'string' || !bookId || !Number.isInteger(index) || index < 0 || !canonicalVoiceId(voiceId) || !(blob instanceof Blob)) throw new Error('音频片段数据无效，无法保存。');
    await this.init();
    return new Promise((resolve, reject) => {
      let transaction, saved = false, request;
      try {
        transaction = this.db.transaction(['books', 'audio'], 'readwrite');
        request = transaction.objectStore('books').get(bookId);
        request.onsuccess = () => {
          if (!request.result) return;
          transaction.objectStore('audio').put({ key: `${bookId}:${voiceId}:${index}`, bookId, voiceId, index, blob });
          saved = true;
        };
      } catch (error) {
        try { transaction?.abort(); } catch {}
        reject(storageError(error)); return;
      }
      transaction.oncomplete = () => resolve(saved);
      transaction.onabort = () => reject(storageError(transaction.error || request?.error));
      transaction.onerror = () => {};
    });
  }

  async putAudioPack(book, audioBlobs) {
    if (typeof book?.id !== 'string' || !book.id || !Array.isArray(book.paragraphs) || !book.paragraphs.length || !Array.isArray(book.audioPack?.voices) || !book.audioPack.voices.length || !isRecord(audioBlobs)) throw new Error('听书包数据无效，无法保存。');
    const tracks = [];
    for (const voice of book.audioPack.voices) {
      if (!canonicalVoiceId(voice.id)) throw new Error('听书包声音格式无效，无法保存。');
      const blobs = audioBlobs[voice.id];
      if (!Array.isArray(blobs) || blobs.length !== book.paragraphs.length || blobs.some(blob => !(blob instanceof Blob))) throw new Error('听书包音频片段不完整，无法保存。');
      blobs.forEach((blob, index) => tracks.push({ key: `${book.id}:${voice.id}:${index}`, bookId: book.id, voiceId: voice.id, index, blob }));
    }
    await this.init();
    await new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = this.db.transaction(['books', 'audio'], 'readwrite');
        transaction.objectStore('books').put(book);
        this.replaceAudioPack(transaction.objectStore('audio'), book.id, tracks);
      } catch (error) {
        try { transaction?.abort(); } catch { /* Already inactive. */ }
        reject(storageError(error));
        return;
      }
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(storageError(transaction.error));
    });
    return book;
  }

  replaceAudioPack(store, bookId, tracks) {
    // The write is one transaction, so a failed audio write cannot leave a partial pack.
    const request = store.indexNames?.contains('bookId') ? store.index('bookId').openCursor(bookId) : store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        for (const track of tracks) store.put(track);
        return;
      }
      if (cursor.value.bookId === bookId) cursor.delete();
      cursor.continue();
    };
  }

  async audioTransaction(mode, operation) {
    await this.init();
    return new Promise((resolve, reject) => {
      let transaction;
      let result;
      let requestError;
      try {
        transaction = this.db.transaction('audio', mode);
        const request = operation(transaction.objectStore('audio'));
        if (request?.onsuccess !== undefined) {
          request.onsuccess = () => { result = request.result; };
          request.onerror = () => { requestError = request.error; };
        }
      } catch (error) {
        try { transaction?.abort(); } catch { /* Already inactive. */ }
        reject(storageError(error));
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(storageError(transaction.error || requestError));
      transaction.onerror = () => {};
    });
  }

  async delete(id) {
    if (typeof id !== 'string' || !id) throw new Error('请选择要移除的书籍。');
    await this.init();
    await new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['books', 'audio'], 'readwrite');
      transaction.objectStore('books').delete(id);
      const store = transaction.objectStore('audio');
      const request = store.indexNames?.contains('bookId') ? store.index('bookId').openCursor(id) : store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (cursor.value.bookId === id) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(storageError(transaction.error || request.error));
    });
  }
}

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
