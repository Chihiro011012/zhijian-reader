import { bookVoices, canonicalVoiceId } from './voices.js';

/** Plays locally imported MP3 paragraphs through one media element. */
export class PackedAudioPlayer extends EventTarget {
  constructor({ store, audio = new Audio(), url = URL, mediaSession = globalThis.navigator?.mediaSession } = {}) {
    super();
    this.store = store;
    this.audio = audio;
    this.url = url;
    this.mediaSession = mediaSession;
    this.supported = Boolean(audio?.play && url?.createObjectURL);
    this.status = 'idle';
    this.index = 0;
    this.rate = 1;
    this.voiceId = 'xiaoxiao';
    this.book = null;
    this.paragraphs = [];
    this._generation = 0;
    this._prepared = null;
    this._loading = null;
    audio.addEventListener('ended', () => this._onEnded());
    audio.addEventListener('error', () => {
      if (this.status === 'playing') this._setStatus('error', '这段音频暂时无法播放，请重新导入听书包。');
    });
    this._installMediaSession();
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  _setStatus(status, error) {
    this.status = status;
    if (this.mediaSession) this.mediaSession.playbackState = status === 'playing' ? 'playing' : 'paused';
    this._emit('statechange', { status, index: this.index, ...(error ? { error } : {}) });
  }
  _installMediaSession() {
    if (!this.mediaSession?.setActionHandler) return;
    for (const [action, handler] of [
      ['play', () => this.play()], ['pause', () => this.pause()],
      ['previoustrack', () => this.seek(this.index - 1)],
      ['nexttrack', () => this.seek(this.index + 1)],
    ]) { try { this.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ } }
  }
  _metadata() {
    if (!this.mediaSession || !this.book || typeof MediaMetadata === 'undefined') return;
    try { this.mediaSession.metadata = new MediaMetadata({ title: this.book.title, artist: this.book.audioPack?.voices?.find(v => v.id === this.voiceId)?.name || '纸间', album: '纸间听书' }); } catch {}
  }
  _clearSource() {
    if (!this._prepared) return;
    this.audio.removeAttribute?.('src');
    this.audio.load?.();
    this.url.revokeObjectURL(this._prepared.url);
    this._prepared = null;
  }
  _clamp(index) { return Math.max(0, Math.min(this.paragraphs.length - 1, Math.floor(Number(index)) || 0)); }

  setBook(book, startIndex = 0) {
    this._generation++;
    this.audio.pause();
    this._clearSource();
    this.book = book || null;
    this.paragraphs = book?.paragraphs || [];
    this.index = this._clamp(startIndex);
    const voices = bookVoices(book);
    const selected = voices.find(voice => voice.id === canonicalVoiceId(this.voiceId)) || voices[0];
    this.voiceId = selected?.trackId || 'xiaoxiao';
    this.audio.playbackRate = this.rate;
    this._metadata();
    this._setStatus('idle');
    this._emit('positionchange', { index: this.index });
    if (selected) void this._prepare(this._generation).catch(() => {});
  }

  async _prepare(generation) {
    const bookId = this.book?.id, index = this.index, voiceId = this.voiceId;
    if (!bookId) return false;
    if (this._prepared?.bookId === bookId && this._prepared.index === index && this._prepared.voiceId === voiceId) return true;
    if (this._loading?.bookId === bookId && this._loading.index === index && this._loading.voiceId === voiceId && this._loading.generation === generation) return this._loading.promise;
    const promise = (async () => {
      const blob = await this.store.getAudio(bookId, index, voiceId);
      if (generation !== this._generation || this.book?.id !== bookId || this.index !== index || this.voiceId !== voiceId) return false;
      if (!(blob instanceof Blob) || !blob.size) throw new Error('这段音频缺失，请重新导入听书包。');
      this._clearSource();
      const source = this.url.createObjectURL(blob);
      this._prepared = { bookId, index, voiceId, url: source };
      this.audio.src = source;
      this.audio.load?.();
      // load() can reset playbackRate to its default; retain the reader's choice.
      this.audio.playbackRate = this.rate;
      return true;
    })();
    this._loading = { bookId, index, voiceId, generation, promise };
    try { return await promise; } finally { if (this._loading?.promise === promise) this._loading = null; }
  }
  _playReady(generation) {
    if (generation !== this._generation || this.status !== 'playing') return;
    try {
      const result = this.audio.play();
      Promise.resolve(result).catch(error => {
        if (generation !== this._generation) return;
        const denied = error?.name === 'NotAllowedError';
        this._setStatus(denied ? 'paused' : 'error', denied ? '音频已准备好，请再点一次播放。' : '音频播放失败，请检查手机声音设置后重试。');
      });
    } catch { this._setStatus('error', '音频播放失败，请点播放重试。'); }
  }
  _start() {
    const generation = this._generation;
    if (this._prepared?.bookId === this.book?.id && this._prepared.index === this.index && this._prepared.voiceId === this.voiceId) {
      this._playReady(generation);
      return;
    }
    void this._prepare(generation).then(ready => { if (ready) this._playReady(generation); }).catch(error => {
      if (generation === this._generation) this._setStatus('error', error?.message || '无法读取本地音频，请重新导入听书包。');
    });
  }
  play() {
    if (!this.book || !this.paragraphs.length || this.status === 'playing') return;
    if (!bookVoices(this.book).length) {
      this._setStatus('error', '这本书还没有自然语音，请先生成并导入四音色听书包。');
      return;
    }
    if (this.status === 'ended') { this.index = 0; this._emit('positionchange', { index: 0 }); }
    this._setStatus('playing');
    this._start();
  }
  pause() {
    if (this.status !== 'playing') return;
    this._generation++;
    this.audio.pause();
    this._setStatus('paused');
  }
  toggle() { this.status === 'playing' ? this.pause() : this.play(); }
  seek(index, { autoplay = this.status === 'playing' } = {}) {
    if (!this.book) return;
    this._generation++;
    this.audio.pause();
    const next = this._clamp(index);
    if (next !== this.index) this._clearSource();
    this.index = next;
    this._emit('positionchange', { index: next });
    this._setStatus('paused');
    if (autoplay) this.play();
    else if (bookVoices(this.book).length) void this._prepare(this._generation).catch(() => {});
  }
  _onEnded() {
    if (this.status !== 'playing') return;
    if (this.index >= this.paragraphs.length - 1) { this._setStatus('ended'); return; }
    this._generation++;
    this._clearSource();
    this.index++;
    this._emit('positionchange', { index: this.index });
    this._start();
  }
  setRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value)) return;
    this.rate = Math.max(0.5, Math.min(2, value));
    this.audio.playbackRate = this.rate;
  }
  setVoice(voiceId) {
    const selected = bookVoices(this.book).find(voice => voice.id === canonicalVoiceId(voiceId));
    if (!selected || this.voiceId === selected.trackId) return;
    const autoplay = this.status === 'playing';
    this.voiceId = selected.trackId;
    this._metadata();
    this._generation++;
    this.audio.pause();
    this._clearSource();
    this._setStatus('paused');
    if (autoplay) this.play();
    else void this._prepare(this._generation).catch(() => {});
  }
  stop() {
    this._generation++;
    this.audio.pause();
    this._clearSource();
    this._setStatus('idle');
  }
}
