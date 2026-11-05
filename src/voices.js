/** A reader preference, never a packaged audio track or online voice. */
export const SYSTEM_VOICE_ID = 'system';

/** The four approved Mandarin voices, shared by the reader and package builder. */
export const NATURAL_VOICES = Object.freeze([
  Object.freeze({ id: 'xiaoxiao', name: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声' }),
  Object.freeze({ id: 'xiaoyi', name: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声' }),
  Object.freeze({ id: 'yunxi', name: 'zh-CN-YunxiNeural', label: '云希 · 男声' }),
  Object.freeze({ id: 'yunyang', name: 'zh-CN-YunyangNeural', label: '云扬 · 男声' }),
]);

export function canonicalVoiceId(id) {
  const current = id === 'female' ? 'xiaoxiao' : id === 'male' ? 'yunxi' : id;
  return NATURAL_VOICES.some(voice => voice.id === current) ? current : '';
}

/** Preserve legacy track keys while verifying the audio's declared voice identity. */
export function packageVoiceFor(id, name) {
  const current = canonicalVoiceId(id);
  return NATURAL_VOICES.find(voice => voice.id === current && voice.name === name);
}

export function bookVoices(book) {
  const tracks = book?.audioPack?.voices || [];
  return NATURAL_VOICES.flatMap(voice => {
    const track = tracks.find(item => packageVoiceFor(item.id, item.name)?.id === voice.id);
    return track ? [{ ...voice, trackId: track.id }] : [];
  });
}
