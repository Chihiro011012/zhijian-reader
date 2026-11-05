import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const root = resolve('dist');
const port = Number(process.env.PORT || 5180);
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
try { await stat(resolve(root, 'index.html')); } catch { console.error('请先运行 npm run build，再运行 npm start。'); process.exit(1); }
const server = http.createServer(async (request, response) => {
  if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    const file = await readFile(path);
    response.writeHead(200, { 'Content-Type':types[extname(path)] || 'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : file);
  } catch { response.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); response.end('没有找到页面'); }
});
server.on('error',error=>{ console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被使用，请关闭旧的纸间服务后重试。` : error.message); process.exitCode=1; });
server.listen(port, '0.0.0.0', () => {
  console.log(`\n纸间已启动： http://localhost:${port}/`);
  console.log('\niPhone 与电脑连接同一 Wi-Fi 后，在 Safari 打开以下局域网地址：');
  for (const values of Object.values(networkInterfaces())) for (const item of values || []) if(item.family==='IPv4'&&!item.internal) console.log(`  http://${item.address}:${port}/`);
  console.log('\n保持此窗口开启。按 Ctrl+C 停止。离线安装需要部署到 HTTPS 网站。\n');
});
