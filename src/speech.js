const CHUNK_LIMIT = 180;

/** Keep utterances short enough for mobile speech engines without splitting emoji. */
export function chunkText(text, limit = CHUNK_LIMIT) {
  const characters = Array.from(String(text ?? '').trim());
  const size = Math.max(1, Math.floor(Number(limit)) || CHUNK_LIMIT);
  const chunks = [];
  let offset = 0;
  while (offset < characters.length) {
    let end = Math.min(offset + size, characters.length);
    if (end < characters.length) {
      // Prefer sentence endings, then a clause boundary, but do not emit tiny chunks.
      const minimum = offset + Math.floor(size * 0.35);
      for (const boundary of [/[。！？!?；;\n]/u, /[，,、：:\s]/u]) {
        let found = -1;
        for (let i = end - 1; i >= minimum; i--) {
          if (boundary.test(characters[i])) { found = i + 1; break; }
        }
        if (found > offset) { end = found; break; }
      }
    }
    const value = characters.slice(offset, end).join('');
    if (value.trim()) chunks.push(value);
    offset = end;
  }
  return chunks;
}

const ERROR_MESSAGES = {
  'not-allowed': '请再点一次播放，并确认浏览器允许播放声音。',
  'audio-busy': '声音正在被其他应用使用，请稍后再试。',
  'audio-hardware': '暂时无法使用扬声器，请检查手机的声音设置。',
  'network': '当前系统声音需要联网，请检查网络，或在系统设置中下载可离线使用的声音。',
  'voice-unavailable': '系统声音暂时不可用，请到系统设置中检查朗读声音。',
  'language-unavailable': '手机还没有可用的中文声音，请在系统设置中下载中文声音。',
  'synthesis-unavailable': '系统朗读暂时不可用，请稍后再试。',
  'text-too-long': '这段文字暂时无法朗读，请换一段重试。',
  'invalid-argument': '当前朗读设置不可用，请调整语速后重试。',
};

/** A paragraph-aware player using the browser's speech service. */
export class SpeechPlayer extends EventTarget {
  constructor({ synthesis = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, defaultVoiceOnly = false } = {}) {
    super();
    this.synthesis = synthesis;
    this.Utterance = Utterance;
    this.defaultVoiceOnly = defaultVoiceOnly;
    this.supported = Boolean(synthesis && typeof synthesis.speak === 'function' && Utterance);
    this.status = 'idle';
    this.index = 0;
    this.rate = 1;
    this.voiceURI = '';
    this.voices = [];
    this.paragraphs = [];
    this._chunkIndex = 0;
    this._generation = 0;
    this._activeUtterance = null;
    this._destroyed = false;
    this._onVoicesChanged = () => this.refreshVoices();
    if (this.supported && !this.defaultVoiceOnly) {
      if (typeof synthesis.addEventListener === 'function') {
        synthesis.addEventListener('voiceschanged', this._onVoicesChanged);
      } else {
        this._previousVoicesChanged = synthesis.onvoiceschanged;
        this._onLegacyVoicesChanged = (event) => {
          this._previousVoicesChanged?.call(synthesis, event);
          this.refreshVoices();
        };
        synthesis.onvoiceschanged = this._onLegacyVoicesChanged;
      }
      this.refreshVoices();
    }
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  _setStatus(status, error) {
    this.status = status;
    this._emit('statechange', { status, index: this.index, ...(error ? { error } : {}) });
  }

  refreshVoices() {
    if (this.defaultVoiceOnly) { this.voices = []; return []; }
    if (!this.supported || this._destroyed) return [];
    try {
      this.voices = [...this.synthesis.getVoices()].sort((a, b) => {
        const chinese = (voice) => /^zh(?:[-_]|$)/i.test(voice.lang) ? 0 : 1;
        return chinese(a) - chinese(b) || a.name.localeCompare(b.name, 'zh');
      });
    } catch { this.voices = []; }
    this._emit('voiceschange', { voices: this.voices });
    return this.voices;
  }

  _cancel() {
    // Invalidate before cancel: Safari can dispatch cancellation synchronously.
    this._generation += 1;
    this._activeUtterance = null;
    if (this.supported) this.synthesis.cancel();
  }

  setBook(paragraphs, startIndex = 0) {
    this._cancel();
    this.paragraphs = Array.isArray(paragraphs) ? paragraphs : [];
    this.index = this._clampIndex(startIndex);
    this._chunkIndex = 0;
    this._setStatus('idle');
    this._emit('positionchange', { index: this.index });
  }

  _clampIndex(index) {
    return Math.max(0, Math.min(this.paragraphs.length - 1, Math.floor(Number(index)) || 0));
  }

  play() {
    if (this._destroyed) return;
    if (!this.supported) {
      this._setStatus('error', '当前浏览器不支持朗读，请在 iPhone 的 Safari 浏览器中打开。');
      return;
    }
    if (!this.paragraphs.length || this.status === 'playing') return;
    if (this.status === 'ended') {
      this.index = 0;
      this._chunkIndex = 0;
      this._emit('positionchange', { index: this.index });
    }
    this._cancel();
    this._setStatus('playing');
    // Do not defer the first speak() call: iPhone requires the user gesture.
    this._speakChunk();
  }

  _speakChunk() {
    if (this.status !== 'playing' || this._destroyed) return;
    let chunks;
    while (this.index < this.paragraphs.length) {
      chunks = chunkText(this.paragraphs[this.index]?.text ?? '');
      if (this._chunkIndex < chunks.length) break;
      this.index += 1;
      this._chunkIndex = 0;
      if (this.index < this.paragraphs.length) this._emit('positionchange', { index: this.index });
    }
    if (this.index >= this.paragraphs.length) {
      this.index = Math.max(0, this.paragraphs.length - 1);
      this._activeUtterance = null;
      this._setStatus('ended');
      return;
    }
    const generation = this._generation;
    let utterance;
    try {
      utterance = new this.Utterance(chunks[this._chunkIndex]);
      utterance.rate = this.rate;
      utterance.pitch = 1;
      utterance.volume = 1;
      if (!this.defaultVoiceOnly) {
        const voice = this.voices.find((item) => item.voiceURI === this.voiceURI)
          || this.voices.find((item) => /^zh(?:[-_]|$)/i.test(item.lang));
        if (voice) utterance.voice = voice;
        utterance.lang = voice?.lang || 'zh-CN';
      }
      const isCurrent = () => !this._destroyed && generation === this._generation
        && this._activeUtterance === utterance && this.status === 'playing';
      utterance.onend = () => {
        if (!isCurrent()) return;
        this._chunkIndex += 1;
        this._activeUtterance = null;
        this._speakChunk();
      };
      utterance.onerror = (event) => {
        if (!isCurrent()) return;
        this._activeUtterance = null;
        if (event.error === 'interrupted' || event.error === 'canceled') {
          this._setStatus('paused');
          return;
        }
        this._setStatus('error', ERROR_MESSAGES[event.error] || '朗读暂时中断，请点播放重试，或到系统设置中检查朗读声音。');
      };
      this._activeUtterance = utterance;
      this.synthesis.speak(utterance);
    } catch {
      this._activeUtterance = null;
      this._setStatus('error', '朗读暂时无法启动，请点播放重试。');
    }
  }

  pause() {
    if (this.status !== 'playing') return;
    this._cancel();
    // Replaying this short chunk is more reliable than Safari's pause/resume.
    this._setStatus('paused');
  }

  toggle() { this.status === 'playing' ? this.pause() : this.play(); }

  seek(index, { autoplay = this.status === 'playing' } = {}) {
    this._cancel();
    this.index = this._clampIndex(index);
    this._chunkIndex = 0;
    this._emit('positionchange', { index: this.index });
    this._setStatus('paused');
    if (autoplay) this.play();
  }

  setRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value)) return;
    this.rate = Math.max(0.5, Math.min(2, value));
    this._restartIfPlaying();
  }

  setVoice(voiceURI) {
    if (this.defaultVoiceOnly) return;
    this.voiceURI = String(voiceURI ?? '');
    this._restartIfPlaying();
  }

  _restartIfPlaying() {
    if (this.status !== 'playing') return;
    this._cancel();
    this._speakChunk();
  }

  stop() {
    this._cancel();
    this._chunkIndex = 0;
    this._setStatus('idle');
  }

  destroy() {
    if (this._destroyed) return;
    this.stop();
    this._destroyed = true;
    if (this.defaultVoiceOnly) return;
    if (typeof this.synthesis?.removeEventListener === 'function') {
      this.synthesis.removeEventListener('voiceschanged', this._onVoicesChanged);
    } else if (this.synthesis?.onvoiceschanged === this._onLegacyVoicesChanged) {
      this.synthesis.onvoiceschanged = this._previousVoicesChanged || null;
    }
  }
}
