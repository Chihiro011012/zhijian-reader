/*! SPDX-License-Identifier: LGPL-3.0-only
 * Wire protocol adapted from rany2/edge-tts (LGPLv3).
 * See NOTICE.md and LICENSE.edge-tts. No user text is logged or stored here.
 */
import { CLIENT_TOKEN, generateSecMsGec } from './drm.js';

export const VOICES = Object.freeze({
  xiaoxiao: 'zh-CN-XiaoxiaoNeural', xiaoyi: 'zh-CN-XiaoyiNeural',
  yunxi: 'zh-CN-YunxiNeural', yunyang: 'zh-CN-YunyangNeural',
});
const MAX_BODY_BYTES = 32768, MAX_TEXT_POINTS = 2000, MAX_AUDIO_BYTES = 8000000;
const UPSTREAM = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const encoder = new TextEncoder(), decoder = new TextDecoder();
let clockSkewSeconds = 0;
const id = () => crypto.randomUUID().replaceAll('-', '');
const abortError = () => new DOMException('Request aborted', 'AbortError');
const escaped = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function splitText(text, maxBytes=3000) {
  const chunks=[]; let current='',bytes=0;
  for(const point of text) {
    const safe=escaped(point),size=encoder.encode(safe).length;
    if(bytes+size>maxBytes && current) { chunks.push(current);current='';bytes=0; }
    current+=safe;bytes+=size;
  }
  if(current) chunks.push(current); return chunks;
}
function timestamp() {
  // Match the date format expected by the read-aloud protocol, including its trailing Z quirk.
  const d=new Date();
  return `${d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.*) GMT$/, '$1 $3 $2 $4 $5')} GMT+0000 (Coordinated Universal Time)`;
}
export function speechMessages(safeText,voice) {
  const stamp=timestamp();
  const config='X-Timestamp:'+stamp+'\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'+JSON.stringify({context:{synthesis:{audio:{metadataoptions:{sentenceBoundaryEnabled:'false',wordBoundaryEnabled:'false'},outputFormat:'audio-24khz-48kbitrate-mono-mp3'}}}})+'\r\n';
  const ssml=`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${safeText}</prosody></voice></speak>`;
  return [config,`X-RequestId:${id()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n${ssml}`];
}
export function audioFrame(data) {
  const bytes=data instanceof Uint8Array?data:new Uint8Array(data);
  if(bytes.length<2) throw new Error('Invalid audio frame');
  const length=(bytes[0]<<8)|bytes[1];
  if(length+2>bytes.length) throw new Error('Invalid audio header');
  const headers=decoder.decode(bytes.subarray(2,2+length));
  if(!/(?:^|\r\n)Path:audio(?:\r\n|$)/.test(headers)) throw new Error('Unexpected audio frame');
  const payload=bytes.subarray(2+length);
  if(!/(?:^|\r\n)Content-Type:audio\/mpeg(?:\r\n|$)/.test(headers)) {
    if(payload.length) throw new Error('Missing audio content type');
    return new Uint8Array();
  }
  return payload;
}
async function connectEdge(signal, fetchImpl) {
  for(let attempt=0;attempt<2;attempt++) {
    const url=new URL(UPSTREAM);
    url.searchParams.set('TrustedClientToken',CLIENT_TOKEN);
    url.searchParams.set('ConnectionId',id());
    url.searchParams.set('Sec-MS-GEC',generateSecMsGec(Date.now()/1000+clockSkewSeconds));
    url.searchParams.set('Sec-MS-GEC-Version','2-143.0.3650.75');
    const response=await fetchImpl(url.toString(),{headers:{
      Upgrade:'websocket', 'Sec-WebSocket-Version':'13',
      Origin:'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Accept-Language':'en-US,en;q=0.9', Pragma:'no-cache', 'Cache-Control':'no-cache',
      Cookie:`muid=${id().toUpperCase()};`,
    },signal});
    if(response.webSocket) { response.webSocket.binaryType='arraybuffer';response.webSocket.accept();return response.webSocket; }
    if(response.status===403&&attempt===0) {
      const date=Date.parse(response.headers.get('Date'));
      if(Number.isFinite(date)) { clockSkewSeconds=(date-Date.now())/1000;continue; }
    }
    throw new Error(`Voice service connection failed (${response.status})`);
  }
  throw new Error('Voice service connection failed');
}
async function synthesizePart(safeText,voice,{signal,fetchImpl,timeoutMs}) {
  const controller=new AbortController();let socket;
  const abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,timeoutMs);
  try {
    if(signal?.aborted) throw abortError();
    socket=await connectEdge(controller.signal,fetchImpl);
    if(controller.signal.aborted) throw abortError();
    return await new Promise((resolve,reject)=>{
      const chunks=[];let bytes=0,settled=false;
      const finish=(error)=>{
        if(settled)return;settled=true;
        socket.removeEventListener('message',onMessage);socket.removeEventListener('error',onError);socket.removeEventListener('close',onClose);
        controller.signal.removeEventListener('abort',onAbort);
        try { socket.close(1000,'Done'); } catch {}
        if(error) {reject(error);return;}
        if(!bytes) {reject(new Error('No audio received'));return;}
        const result=new Uint8Array(bytes);let offset=0;
        for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}resolve(result);
      };
      const onAbort=()=>finish(abortError());
      const onError=()=>finish(new Error('Voice service interrupted'));
      const onClose=()=>finish(new Error('Voice service closed before completion'));
      const onMessage=event=>{
        try {
          if(typeof event.data==='string') {
            if(/(?:^|\r\n)Path:turn.end(?:\r\n|$)/.test(event.data))finish();
          } else {
            const chunk=audioFrame(event.data);
            bytes+=chunk.length;if(bytes>MAX_AUDIO_BYTES)throw new Error('Audio response too large');
            if(chunk.length)chunks.push(chunk);
          }
        } catch(error){finish(error);}
      };
      controller.signal.addEventListener('abort',onAbort,{once:true});
      socket.addEventListener('message',onMessage);socket.addEventListener('error',onError);socket.addEventListener('close',onClose);
      if(controller.signal.aborted) {onAbort();return;}
      try {for(const message of speechMessages(safeText,voice)) socket.send(message);}
      catch(error){finish(error);}
    });
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    try {socket?.close(1000,'Done');}catch{}
  }
}
export async function synthesize(text,voice,{signal,fetchImpl=fetch,timeoutMs=25000}={}) {
  const chunks=[];let bytes=0;
  for(const part of splitText(text)) {
    if(signal?.aborted)throw abortError();
    const audio=await synthesizePart(part,voice,{signal,fetchImpl,timeoutMs});
    chunks.push(audio);bytes+=audio.length;if(bytes>MAX_AUDIO_BYTES)throw new Error('Audio response too large');
  }
  const result=new Uint8Array(bytes);let offset=0;
  for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
function cors(origin) {
  return {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400','Vary':'Origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
}
async function boundedBody(request) {
  if(Number(request.headers.get('Content-Length'))>MAX_BODY_BYTES)throw new RangeError('Request too large');
  const reader=request.body?.getReader();if(!reader)return '';
  let size=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BODY_BYTES){await reader.cancel();throw new RangeError('Request too large');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return decoder.decode(bytes);
}
export function createHandler({synthesizeImpl=synthesize}={}) {
  return async (request,env={})=>{
    const origin=request.headers.get('Origin')||'';
    const allowed=String(env.ALLOWED_ORIGINS||'https://chihiro011012.github.io').split(',').map(x=>x.trim()).filter(Boolean);
    const url=new URL(request.url);
    const headers=cors(origin);
    const json=(status,error)=>new Response(JSON.stringify({error}),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8'}});
    if(request.method==='GET'&&url.pathname==='/health')return new Response(JSON.stringify({ok:true,voices:Object.keys(VOICES)}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store',...(allowed.includes(origin)?headers:{})}});
    if(!allowed.includes(origin))return new Response('Origin not allowed',{status:403,headers:{'Cache-Control':'no-store'}});
    if(url.pathname!=='/v1/tts')return json(404,'not_found');
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return json(405,'method_not_allowed');
    if(!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')||''))return json(415,'json_required');
    let input;
    try {input=JSON.parse(await boundedBody(request));}catch(error){return json(error instanceof RangeError?413:400,'invalid_request');}
    const text=input?.text, voice=input?.voice;
    if(typeof text!=='string'||!text.trim()||Array.from(text).length>MAX_TEXT_POINTS||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)||Array.from(text).some(x=>x.length===1&&x.charCodeAt(0)>=0xd800&&x.charCodeAt(0)<=0xdfff)||typeof voice!=='string'||!Object.hasOwn(VOICES,voice))return json(400,'invalid_text_or_voice');
    try {
      const audio=await synthesizeImpl(text,VOICES[voice],{signal:request.signal});
      if(request.signal.aborted)return json(499,'cancelled');
      return new Response(audio,{headers:{...headers,'Content-Type':'audio/mpeg','Content-Length':String(audio.byteLength)}});
    }catch(error){return json(error?.name==='AbortError'?504:502,error?.name==='AbortError'?'voice_request_cancelled_or_timed_out':'voice_service_unavailable');}
  };
}
export default {fetch:createHandler()};
