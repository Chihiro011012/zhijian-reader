/*! SPDX-License-Identifier: LGPL-3.0-only
 * JavaScript port of edge-tts src/edge_tts/drm.py.
 * Copyright (c) 2025- rany <rany@riseup.net> and contributors.
 * Modified 2026: Worker-compatible token generation, 32-bit arithmetic and cache.
 * Upstream: https://github.com/rany2/edge-tts
 * License and source attribution: ./LICENSE.edge-tts, ./NOTICE.md.
 */
export const CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const INITIAL = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
const STATE = [0xfd9fbea2,0x91243ce7,0xbe499094,0xcd2e1e0a,0x6c006f49,0x04bd35ab,0xfeb0a7e4,0x03effbd2];
const SCHEDULE = [0xeb24bf9e,0x1558691f,0xa0c09ee2,0x0cfa32ba,0xa622ee8c,0xd1dd9491,0xc0dd25a0,0xf9e70ab6,0xf0c31573,0x7058ce4e,0x7188e606,0x00e5ab33,0xd258b060,0x72766564];
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const COEFFICIENTS = [[0xe82e91b1,0xb32700d0],[0x44de24c6,0x88dff51d],[0x3beb65bc,0x29514038],[0xc89c5933,0xb328cbdf],[0x8d1ec211,0xd405b4d5],[0x314ef5d5,0x26e55f3c],[0xe92491b1,0x607801c6],[0xf0a5b9d5,0x82b2c1fb],[0x06064cf3,0xfa51a3da],[0xda79fa60,0x207cc464],[0xbed20560,0x3c3c74f3],[0x89f9c9f8,0xd2d14b61],[0x35fa38c6,0xbb04a2c1],[0xcb49e3c6,0xc5626167]];
const u = value => value >>> 0;
const mul = (a,b) => Math.imul(a,b) >>> 0;
const rol16 = x => u((x << 16) | (x >>> 16));
const rotr = (x,n) => u((x >>> n) | (x << (32-n)));
const sigma0 = x => u(rotr(x,7)^rotr(x,18)^(x>>>3));
const sigma1 = x => u(rotr(x,17)^rotr(x,19)^(x>>>10));
function expand(words,start=16) {
  for(let i=start;i<64;i++) words[i]=u(sigma1(words[i-2])+words[i-7]+sigma0(words[i-15])+words[i-16]);
}
function rounds(state,words,start=0) {
  let [a,b,c,d,e,f,g,h]=state;
  for(let i=start;i<64;i++) {
    const constant = start===14&&i===14 ? 0xc9dc06a7 : K[i];
    const t1=u(h+(rotr(e,6)^rotr(e,11)^rotr(e,25))+(g^(e&(f^g)))+constant+words[i]);
    const t2=u((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)|(c&(a|b))));
    [a,b,c,d,e,f,g,h]=[u(t1+t2),a,b,c,u(d+t1),e,f,g];
  }
  return [a,b,c,d,e,f,g,h];
}
function sha256Initial(data) {
  const words=Array(14).fill(0);
  words.push((data[0]<<16)|(data[1]<<8)|data[2]);
  words.push(new DataView(data.buffer,data.byteOffset).getUint32(3));
  for(let i=16;i<30;i++) {
    let v=SCHEDULE[i-16];
    if(i-2>=14) v+=i===16 ? u(sigma1(words[i-2])^0x000b92c0) : sigma1(words[i-2]);
    if(i-7>=14) v+=words[i-7];
    if(i-15>=14) v+=i===29 ? u(sigma0(words[i-15])^0x059c0b80) : sigma0(words[i-15]);
    words.push(u(v));
  }
  words.push(u(sigma1(words[28])+words[23]+sigma0(words[15])+words[14]+0xc9dc06a7-K[14]));
  expand(words,31);
  return rounds(STATE,words,14).map((x,i)=>u(x+INITIAL[i]));
}
function tokenDigest(data) {
  const length=57+data.length;
  const padding=(55-length)%64+64;
  const zeroCount=padding%64;
  const padded=new Uint8Array(data.length-7+1+zeroCount+8);
  padded.set(data.subarray(7)); padded[data.length-7]=0x80;
  const view=new DataView(padded.buffer);
  view.setBigUint64(padded.length-8,BigInt(length*8));
  let state=sha256Initial(data);
  for(let offset=0;offset<padded.length;offset+=64) {
    const words=Array.from({length:16},(_,i)=>view.getUint32(offset+i*4));
    expand(words); state=rounds(state,words).map((x,i)=>u(x+state[i]));
  }
  const digest=new Uint8Array(32), out=new DataView(digest.buffer);
  state.forEach((x,i)=>out.setUint32(i*4,x)); return digest;
}
function cs64(data,digest) {
  const dv=new DataView(digest.buffer,digest.byteOffset), a=u(dv.getUint32(0,true)|1), b=u(dv.getUint32(4,true)|1);
  const factors=[mul(a,0x82893933),mul(b,0x82893933)];
  const terms=COEFFICIENTS.map(([c],i)=>mul(c,factors[i%2]));
  const offsets=COEFFICIENTS.map(([,o])=>o);
  const bytes=new Uint8Array(Math.ceil((data.length+1)/8)*8); bytes.set(data,1);
  const words=new DataView(bytes.buffer);
  for(let i=0;i<bytes.length/4;i++) {
    const word=words.getUint32(i*4,true);
    let term=mul(word,i%2===0?a:b), offset=mul(rol16(word),i%2===0?0xef0569fb:0xc31713db);
    if(i===0) {term=u(term+mul(0xf2f90b1a,factors[0])); offset=u(offset+0x0b1a0000);}
    terms.push(term); offsets.push(offset);
  }
  let swapAcc=0,swapLast=0,state=0,acc=0;
  for(let i=0;i<terms.length;i+=2) {
    const x=terms[i], y=terms[i+1];
    let t=rol16(u(offsets[i]+x)), q=mul(t,0x76f50f34);
    swapAcc+=u(mul(rol16(q),0xc3efea97)+q);
    t=rol16(u(offsets[i+1]+y)); q=mul(t,0x1881ce3c);
    swapLast=u(mul(rol16(q),0x35bd1ec9)+q); swapAcc=u(swapAcc+swapLast);
    state=u(mul(state,a)+x);
    for(const c of [0xcf98b111,0x87085b9f,0x12ceb96d,0x257e1d83]) state=mul(rol16(state),c);
    acc+=state;
    t=u(mul(state,b)+y); t=mul(rol16(t),0xa27416f5); t=mul(rol16(t),0xd38396ff);
    state=mul(rol16(mul(rol16(t),0x7c932b89)),0xbfa49f69); acc=u(acc+state);
  }
  const bytesOut=new Uint8Array(8), out=new DataView(bytesOut.buffer);
  out.setUint32(0,u(swapLast^state),true);out.setUint32(4,u(swapAcc^acc),true);return bytesOut;
}
const hex = bytes => Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();
let cachedBucket, cachedToken;
export function generateSecMsGec(unixSeconds=Date.now()/1000) {
  const bucket=Math.floor((unixSeconds+11644473600)/300)*300;
  if(bucket===cachedBucket) return cachedToken;
  const data=new TextEncoder().encode(`${BigInt(bucket)*10000000n}${CLIENT_TOKEN}`);
  const digest=tokenDigest(data);
  cachedToken=`${hex(cs64(data,digest))}-${hex(digest)}`;cachedBucket=bucket;return cachedToken;
}
