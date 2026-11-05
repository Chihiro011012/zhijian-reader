import { NATURAL_VOICES, bookVoices, canonicalVoiceId } from './voices.js';

/** Plays packaged, cached, and explicitly requested online audio in one element. */
export class PackedAudioPlayer extends EventTarget {
  constructor({ store, provider, audio = new Audio(), url = URL, mediaSession = globalThis.navigator?.mediaSession } = {}) {
    super();
    this.store = store;
    this.provider = provider;
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
    this._controller = null;
    audio.addEventListener('ended', () => this._onEnded());
    audio.addEventListener('error', () => {
      if (this.status === 'playing') this._setStatus('error', '这段音频暂时无法播放，请点播放重试。');
    });
    this._installMediaSession();
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  _setStatus(status, error) {
    this.status = status;
    if (this.mediaSession) this.mediaSession.playbackState = status === 'playing' ? 'playing' : 'paused';
    this._emit('statechange', { status, index: this.index, ...(error ? { error } : {}) });
  }
  get active() { return this.status === 'playing' || this.status === 'loading'; }
  _cancel() {
    this._generation++;
    this._controller?.abort();
    this._controller = null;
    this._loading = null;
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
    const voice = NATURAL_VOICES.find(item => item.id === canonicalVoiceId(this.voiceId));
    try { this.mediaSession.metadata = new MediaMetadata({ title: this.book.title, artist: voice?.label || '纸间', album: '纸间听书' }); } catch {}
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
    this._cancel();
    this.audio.pause();
    this._clearSource();
    this.book = book || null;
    this.paragraphs = book?.paragraphs || [];
    this.index = this._clamp(startIndex);
    const voices = bookVoices(book);
    const selected = voices.find(voice => voice.id === canonicalVoiceId(this.voiceId)) || voices[0];
    this.voiceId = selected?.trackId || canonicalVoiceId(this.voiceId) || 'xiaoxiao';
    this.audio.playbackRate = this.rate;
    this._metadata();
    this._setStatus('idle');
    this._emit('positionchange', { index: this.index });
    // Package preparation is local only. Ordinary documents wait for explicit Play.
    if (selected) void this._prepare(this._generation).catch(() => {});
  }

  async _prepare(generation, { allowGenerate = false } = {}) {
    const bookId = this.book?.id, index = this.index, voiceId = this.voiceId;
    if (!bookId) return false;
    const current = () => generation === this._generation && this.book?.id === bookId && this.index === index && this.voiceId === voiceId;
    if (this._prepared?.bookId === bookId && this._prepared.index === index && this._prepared.voiceId === voiceId) return true;
    if (this._loading?.bookId === bookId && this._loading.index === index && this._loading.voiceId === voiceId && this._loading.generation === generation) return this._loading.promise;
    const controller = new AbortController();
    this._controller = controller;
    const packed = bookVoices(this.book).length > 0;
    const text = this.paragraphs[index]?.text;
    const promise = (async () => {
      let blob, cacheAvailable = true;
      try { blob = await this.store.getAudio(bookId, index, voiceId); }
      catch (error) {
        if (!current() || controller.signal.aborted) return false;
        if (packed) throw error;
        cacheAvailable = false;
        this._emit('cachewarning', { message: '无法读取本机音频缓存，本次可在线朗读，音频暂不保存。' });
      }
      if (!current()) return false;
      if (!(blob instanceof Blob) || !blob.size) {
        if (packed) throw new Error('这段听书包音频缺失，请重新导入听书包。');
        if (!allowGenerate) return false;
        if (!this.provider?.generate) throw new Error('在线语音服务尚未配置，请在设置中连接服务后重试。');
        blob = await this.provider.generate({ text, voiceId: canonicalVoiceId(voiceId), signal: controller.signal });
        if (!current() || controller.signal.aborted) return false;
        if (!(blob instanceof Blob) || !blob.size) throw new Error('语音服务没有返回音频，请点播放重试。');
        try {
          // A temporary bookshelf may have no persistent book record to check.
          if (cacheAvailable && this.store.putAudioIfBookExists) {
            const saved = await this.store.putAudioIfBookExists(bookId, index, blob, voiceId);
            if (saved === false) throw new Error('这本书已被移除，请重新导入后播放。');
          } else if (cacheAvailable && this.store.putAudio) {
            await this.store.putAudio(bookId, index, blob, voiceId);
          }
        } catch (error) {
          if (!current()) return false;
          if (/已被移除/.test(error?.message || '')) throw error;
          this._emit('cachewarning', { message: error?.message || '音频未能保存，本段仍可播放。' });
        }
      }
      if (!current() || controller.signal.aborted) return false;
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
    try { return await promise; } finally {
      if (this._loading?.promise === promise) this._loading = null;
      if (this._controller === controller) this._controller = null;
    }
  }
  _playReady(generation) {
    if (generation !== this._generation || !this.active) return;
    this._setStatus('playing');
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
    this._setStatus('loading');
    void this._prepare(generation, { allowGenerate: true }).then(ready => { if (ready) this._playReady(generation); }).catch(error => {
      if (generation === this._generation && error?.name === 'ConsentRequiredError') { this._setStatus('paused'); return; }
      if (generation === this._generation && error?.name !== 'AbortError') this._setStatus('error', error?.message || '无法取得音频，请检查网络后点播放重试。');
    });
  }
  play() {
    if (!this.book || !this.paragraphs.length || this.active) return;
    if (this.status === 'ended') { this.index = 0; this._emit('positionchange', { index: 0 }); }
    this._setStatus('loading');
    this._start();
  }
  pause() {
    if (!this.active) return;
    this._cancel();
    this.audio.pause();
    this._setStatus('paused');
  }
  toggle() { this.active ? this.pause() : this.play(); }
  seek(index, { autoplay = this.active } = {}) {
    if (!this.book) return;
    this._cancel();
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
    this._cancel();
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
    const canonical = canonicalVoiceId(voiceId);
    if (!canonical) return;
    const voices = bookVoices(this.book);
    const selected = voices.find(voice => voice.id === canonical);
    if (voices.length && !selected) return;
    const trackId = selected?.trackId || canonical;
    if (this.voiceId === trackId) return;
    const autoplay = this.active;
    this.voiceId = trackId;
    this._metadata();
    this._cancel();
    this.audio.pause();
    this._clearSource();
    this._setStatus('paused');
    if (autoplay) this.play();
    else if (selected) void this._prepare(this._generation).catch(() => {});
  }
  stop() {
    this._cancel();
    this.audio.pause();
    this._clearSource();
    this._setStatus('idle');
  }
}
