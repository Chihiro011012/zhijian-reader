import { canonicalVoiceId } from './voices.js';

export const MAX_TTS_CHARS = 2000;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const abortError = () => new DOMException('朗读已取消。', 'AbortError');

/** Split at punctuation when possible, retaining every Unicode code point. */
export function splitSpeechText(text, limit = MAX_TTS_CHARS) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('这一段没有可朗读的文字。');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TTS_CHARS) throw new Error('语音分段长度无效。');
  const points = Array.from(text);
  const chunks = [];
  for (let start = 0; start < points.length;) {
    let end = Math.min(start + limit, points.length);
    if (end < points.length) {
      for (let index = end - 1; index >= start + Math.floor(limit / 2); index--) {
        if (/[。！？；.!?;\n]/u.test(points[index])) { end = index + 1; break; }
      }
    }
    chunks.push(points.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}

export function validTtsEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return !url.username && !url.password && !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}

/** Calls only the configured gateway, after the reader has agreed to online speech. */
export class OnlineTtsProvider {
  constructor({ endpoint = '', fetch = globalThis.fetch?.bind(globalThis), canGenerate = () => true, timeoutMs = 45000 } = {}) {
    this.endpoint = endpoint;
    this.fetch = fetch;
    this.canGenerate = canGenerate;
    this.timeoutMs = timeoutMs;
  }
  get configured() { return validTtsEndpoint(this.endpoint) && typeof this.fetch === 'function'; }

  async generate({ text, voiceId, signal } = {}) {
    const voice = canonicalVoiceId(voiceId);
    if (!voice) throw new Error('请选择晓晓、晓伊、云希或云扬。');
    if (!this.configured) throw new Error('在线语音服务尚未配置，暂时无法生成新音频。');
    const endpoint = this.endpoint;
    // Smaller requests keep phone wait times below the gateway's synthesis timeout.
    const chunks = splitSpeechText(text, 800);
    const audio = [];
    let totalBytes = 0;
    for (const chunk of chunks) {
      if (signal?.aborted) throw abortError();
      if (!chunk.trim()) continue;
      if (!this.canGenerate(endpoint)) throw Object.assign(new Error('请先同意将当前段落发送到在线语音服务。'), { name: 'ConsentRequiredError' });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      try {
        const response = await this.fetch(endpoint, {
          method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: chunk, voice }), signal: controller.signal,
        });
        if (signal?.aborted) throw abortError();
        if (!response.ok) {
          const messages = {
            400: '语音请求无效，请重新选择段落后重试。',
            403: '在线语音服务未允许当前网页，请检查服务设置。',
            413: '这段文字过长，请更新语音服务后重试。',
            429: '语音服务繁忙，请稍后再点播放。',
            503: '语音服务暂时不可用，请稍后再点播放。',
          };
          throw new Error(messages[response.status] || (response.status >= 500 ? '语音服务暂时不可用，请稍后再点播放。' : '在线语音生成失败，请稍后点播放重试。'));
        }
        if (!/^audio\/(mpeg|mp3)(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')) throw new Error('语音服务返回的音频格式不正确，请检查服务设置。');
        const declared = Number(response.headers.get('Content-Length'));
        if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES - totalBytes) throw new Error('返回的音频过大，请换一段后重试。');
        const reader = response.body?.getReader?.();
        const parts = [];
        let size = 0;
        if (reader) {
          try {
            while (true) {
              const next = await reader.read();
              if (signal?.aborted || controller.signal.aborted) throw abortError();
              if (next.done) break;
              size += next.value.byteLength;
              if (totalBytes + size > MAX_AUDIO_BYTES) throw new Error('返回的音频过大，请换一段后重试。');
              parts.push(next.value);
            }
          } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        } else {
          const data = await response.arrayBuffer();
          size = data.byteLength;
          if (totalBytes + size > MAX_AUDIO_BYTES) throw new Error('返回的音频过大，请换一段后重试。');
          parts.push(data);
        }
        if (controller.signal.aborted) throw abortError();
        if (!size) throw new Error('语音服务没有返回音频，请点播放重试。');
        totalBytes += size;
        audio.push(new Blob(parts, { type: 'audio/mpeg' }));
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (timedOut) throw new Error('生成声音超时，请检查网络后点播放重试。');
        if (error?.name === 'TypeError') throw new Error('无法连接在线语音服务，请检查网络和服务地址后重试。');
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    }
    if (signal?.aborted) throw abortError();
    return new Blob(audio, { type: 'audio/mpeg' });
  }
}
