import { PackedAudioPlayer } from './audio-player.js';
import { SpeechPlayer } from './speech.js';
import { NATURAL_VOICES, SYSTEM_VOICE_ID, bookVoices, canonicalVoiceId } from './voices.js';

/** Keep one reading position while switching between audio and system speech. */
export class ReaderPlayer extends EventTarget {
  constructor({ audioPlayer, speechPlayer, mediaSession = globalThis.navigator?.mediaSession, ...audioOptions } = {}) {
    super();
    this.audioPlayer = audioPlayer || new PackedAudioPlayer({ ...audioOptions, mediaSession: null });
    this.speechPlayer = speechPlayer || new SpeechPlayer({ defaultVoiceOnly: true });
    this.mediaSession = mediaSession;
    this.book = null;
    this.voiceId = 'xiaoxiao';
    this._changing = false;
    for (const source of [this.audioPlayer, this.speechPlayer]) {
      for (const name of ['statechange', 'positionchange', 'cachewarning']) {
        source.addEventListener(name, event => {
          if (this._changing || source !== this._player) return;
          if (name === 'statechange') this._updateMediaSession();
          this._emit(name, event.detail);
        });
      }
    }
    this._installMediaSession();
  }

  get _player() { return this.voiceId === SYSTEM_VOICE_ID ? this.speechPlayer : this.audioPlayer; }
  get status() { return this._player.status; }
  get index() { return this._player.index; }
  get supported() { return this._player.supported; }
  get systemSupported() { return this.speechPlayer.supported; }
  get active() { return this.status === 'playing' || this.status === 'loading'; }
  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  _voiceForBook(voiceId) {
    if (voiceId === SYSTEM_VOICE_ID) return voiceId;
    const canonical = canonicalVoiceId(voiceId) || 'xiaoxiao';
    const available = bookVoices(this.book);
    return available.length && !available.some(voice => voice.id === canonical) ? available[0].id : canonical;
  }

  setBook(book, startIndex = 0, voiceId = this.voiceId) {
    this._changing = true;
    try {
      this.audioPlayer.stop();
      this.speechPlayer.stop();
      this.book = book || null;
      this.voiceId = this._voiceForBook(voiceId);
      this._loadPlayer(startIndex);
    } finally { this._changing = false; }
    this._updateMediaSession();
    this._emit('statechange', { status: this.status, index: this.index });
    this._emit('positionchange', { index: this.index });
  }

  _loadPlayer(index) {
    if (this.voiceId === SYSTEM_VOICE_ID) this.speechPlayer.setBook(this.book?.paragraphs || [], index);
    else {
      this.audioPlayer.setBook(this.book, index);
      this.audioPlayer.setVoice(this.voiceId);
    }
  }

  setVoice(voiceId) {
    const selected = voiceId === SYSTEM_VOICE_ID ? voiceId : canonicalVoiceId(voiceId);
    if (!selected || this._voiceForBook(selected) !== selected || selected === this.voiceId) return;
    const autoplay = this.active;
    const index = this.index;
    this._changing = true;
    try {
      this.audioPlayer.stop();
      this.speechPlayer.stop();
      this.voiceId = selected;
      this._loadPlayer(index);
    } finally { this._changing = false; }
    this._updateMediaSession();
    this._emit('statechange', { status: this.status, index: this.index });
    if (autoplay) this.play();
  }

  play() { this._player.play(); }
  pause() { this._player.pause(); }
  toggle() { this.active ? this.pause() : this.play(); }
  seek(index, { autoplay = this.active } = {}) { this._player.seek(index, { autoplay }); }
  setRate(rate) {
    this.audioPlayer.setRate(rate);
    this.speechPlayer.setRate(rate);
  }
  stop() {
    this.audioPlayer.stop();
    this.speechPlayer.stop();
  }

  _installMediaSession() {
    if (!this.mediaSession?.setActionHandler) return;
    for (const [action, handler] of [
      ['play', () => this.play()], ['pause', () => this.pause()],
      ['previoustrack', () => this.seek(this.index - 1)],
      ['nexttrack', () => this.seek(this.index + 1)],
    ]) { try { this.mediaSession.setActionHandler(action, handler); } catch {} }
  }

  _updateMediaSession() {
    if (!this.mediaSession) return;
    try {
      this.mediaSession.playbackState = this.status === 'playing' ? 'playing' : 'paused';
      if (this.book && typeof MediaMetadata !== 'undefined') {
        const voice = NATURAL_VOICES.find(item => item.id === this.voiceId);
        this.mediaSession.metadata = new MediaMetadata({ title: this.book.title, artist: voice?.label || '系统默认声音', album: '纸间听书' });
      }
    } catch {}
  }
}
