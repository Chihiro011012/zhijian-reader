import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecMsGec } from '../worker/drm.js';
import { VOICES, audioFrame, createHandler, splitText, speechMessages, synthesize } from '../worker/index.js';

const ORIGIN='https://chihiro011012.github.io';
const request=(input,overrides={})=>new Request('https://voice.example/v1/tts',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(input),...overrides});
function frame(payload=new Uint8Array([0xff,0xfb,0x90,0x00])) {
  const headers=new TextEncoder().encode('Path:audio\r\nContent-Type:audio/mpeg\r\n');
  const bytes=new Uint8Array(2+headers.length+payload.length);new DataView(bytes.buffer).setUint16(0,headers.length);
  bytes.set(headers,2);bytes.set(payload,2+headers.length);return bytes;
}
class Socket extends EventTarget {
  sent=[];closed=false;accepted=false;
  accept(){this.accepted=true;}
  close(){this.closed=true;}
  emit(type,data){const event=new Event(type);Object.defineProperty(event,'data',{value:data});this.dispatchEvent(event);}
  send(data){this.sent.push(data);if(data.includes('Path:ssml'))queueMicrotask(()=>{this.emit('message',frame().buffer);this.emit('message','X-RequestId:abc\r\nPath:turn.end\r\n\r\n');});}
}

test('gateway GEC v2 matches current edge-tts golden vectors and bucket boundary',()=>{
  const vectors=[
    [0,'52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6'],
    [1700000000,'2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2'],
    [1793846400,'B830D847745EAD48-52CDC5898C086BE9EF0ECF60731408748D249F63FDB7801191722294054BD58B'],
    [1793846699,'B830D847745EAD48-52CDC5898C086BE9EF0ECF60731408748D249F63FDB7801191722294054BD58B'],
    [1793846700,'8229D6F8F95D0724-2933F847C4C6930897F9B33D9CE8989639424F22F22E8D8038E626AEE7180F25'],
  ];
  for(const [time,expected] of vectors)assert.equal(generateSecMsGec(time),expected);
});
test('gateway accepts only four canonical voices and returns uncached MP3',async()=>{
  const seen=[];const handler=createHandler({synthesizeImpl:async(text,voice)=>{seen.push([text,voice]);return new Uint8Array([0xff,0xfb]);}});
  for(const voice of Object.keys(VOICES)){
    const result=await handler(request({text:'测试文字。',voice}));
    assert.equal(result.status,200);assert.equal(result.headers.get('Content-Type'),'audio/mpeg');assert.equal(result.headers.get('Access-Control-Allow-Origin'),ORIGIN);assert.equal(result.headers.get('Cache-Control'),'no-store');
  }
  assert.deepEqual(seen.map(x=>x[1]),Object.values(VOICES));
  for(const voice of ['en-US-AriaNeural','female','zh-CN-XiaoxiaoNeural',['xiaoxiao'],'__proto__'])assert.equal((await handler(request({text:'测试',voice}))).status,400);
});
test('gateway rejects disallowed origins before synthesis and answers allowed preflight',async()=>{
  const handler=createHandler({synthesizeImpl:()=>{throw new Error('should not run');}});
  assert.equal((await handler(request({text:'测试',voice:'xiaoxiao'},{headers:{Origin:'https://other.example','Content-Type':'application/json'}}))).status,403);
  assert.equal((await handler(request({text:'测试',voice:'xiaoxiao'},{headers:{'Content-Type':'application/json'}}))).status,403);
  const response=await handler(new Request('https://voice.example/v1/tts',{method:'OPTIONS',headers:{Origin:ORIGIN}}));assert.equal(response.status,204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),ORIGIN);
});
test('gateway validates body, codepoint limit and XML characters before synthesis',async()=>{
  const handler=createHandler({synthesizeImpl:async()=>new Uint8Array([1])});
  for(const text of ['', '   ', '中'.repeat(2001), 'bad\0text', '\ud800'])assert.equal((await handler(request({text,voice:'xiaoxiao'}))).status,400);
  assert.equal((await handler(request({text:'😀'.repeat(2000),voice:'yunxi'}))).status,200);
  assert.equal((await handler(request({text:'a'.repeat(33000),voice:'xiaoxiao'}))).status,413);
  assert.equal((await handler(request({}, {body:'{bad'}))).status,400);
  assert.equal((await handler(request({}, {headers:{Origin:ORIGIN,'Content-Type':'text/plain'}}))).status,415);
});
test('gateway splits escaped text within protocol byte limit without text or entity loss',()=>{
  const text='中<&😀\n'.repeat(400);
  const pieces=splitText(text);assert.ok(pieces.length>1);
  for(const piece of pieces)assert.ok(new TextEncoder().encode(piece).length<=3000);
  assert.equal(pieces.join(''),text.replaceAll('&','&amp;').replaceAll('<','&lt;'));
  const messages=speechMessages('&lt;测试&gt;',VOICES.xiaoxiao);
  assert.match(messages[0],/audio-24khz-48kbitrate-mono-mp3/);assert.match(messages[1],/name='zh-CN-XiaoxiaoNeural'/);assert.match(messages[1],/&lt;测试&gt;/);
});
test('gateway parses binary audio frames and rejects malformed frames',()=>{
  assert.deepEqual(audioFrame(frame()),new Uint8Array([0xff,0xfb,0x90,0]));
  assert.throws(()=>audioFrame(new Uint8Array([0])));assert.throws(()=>audioFrame(new Uint8Array([255,255,0])));
  const endHeader=new TextEncoder().encode('Path:audio\r\n');const end=new Uint8Array(2+endHeader.length);end[1]=endHeader.length;end.set(endHeader,2);assert.equal(audioFrame(end).length,0);
});
test('gateway collects actual protocol sequence and closes sockets on completion',async()=>{
  const sockets=[];
  const result=await synthesize('中'.repeat(1500),VOICES.xiaoxiao,{fetchImpl:async(url,options)=>{
    assert.match(url,/Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}/);assert.equal(options.headers.Upgrade,'websocket');
    const socket=new Socket();sockets.push(socket);return {webSocket:socket};
  }});
  assert.equal(sockets.length,2);assert.equal(result.length,8);assert.ok(sockets.every(x=>x.accepted&&x.closed&&x.sent.length===2));
});
test('gateway abort and timeout cancel pending connections; errors are retryable',async()=>{
  const connect=async(_url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
  await assert.rejects(synthesize('测试',VOICES.yunxi,{fetchImpl:connect,timeoutMs:2}),{name:'AbortError'});
  const controller=new AbortController();controller.abort();await assert.rejects(synthesize('测试',VOICES.yunxi,{signal:controller.signal,fetchImpl:connect}),{name:'AbortError'});
  const handler=createHandler({synthesizeImpl:async()=>{throw new Error('sensitive service detail');}});
  const response=await handler(request({text:'测试',voice:'yunxi'}));assert.equal(response.status,502);assert.equal(await response.text(),'{"error":"voice_service_unavailable"}');
});
test('gateway cancellation closes an active socket without returning partial audio',async()=>{
  const controller=new AbortController(),socket=new Socket();socket.send=function(data){this.sent.push(data);};
  const pending=synthesize('测试',VOICES.yunyang,{signal:controller.signal,fetchImpl:async()=>({webSocket:socket})});
  await new Promise(resolve=>setTimeout(resolve,1));
  socket.emit('message',frame().buffer);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(socket.closed,true);
});
test('gateway early close rejects partial audio and releases connection',async()=>{
  const socket=new Socket();socket.send=function(data){if(data.includes('Path:ssml'))queueMicrotask(()=>{this.emit('message',frame().buffer);this.emit('close');});};
  await assert.rejects(synthesize('测试',VOICES.yunyang,{fetchImpl:async()=>({webSocket:socket})}),/closed before completion/);
  assert.equal(socket.closed,true);
});
