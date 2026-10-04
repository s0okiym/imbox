import { createServer, request as proxyRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const commit = process.env.IMBOX_COMPAT_CLIENT_COMMIT ?? '2f751069fc11062f48cfd5d377db2970e9088268';
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Full historical commit required');
const historical = resolve('.artifacts', `historical-web-${commit}`);
const manifest = JSON.parse(await readFile(resolve(historical, 'client-build.json'), 'utf8'));
if (manifest.commit !== commit) throw new Error('Historical build identity mismatch');
const historicalFiles = new Map();
for (const [file, hash] of Object.entries(manifest.files)) {
  if (file.startsWith('/') || file.split('/').includes('..')) throw new Error('Invalid build path');
  const body = await readFile(resolve(historical, 'apps/web/dist', file));
  if (createHash('sha256').update(body).digest('hex') !== hash)
    throw new Error('Historical build hash mismatch');
  historicalFiles.set(file, body);
}
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
let backendPort = 4110;
const connections = new Set();
function forwarding(req) {
  return proxyRequest({
    hostname: '127.0.0.1',
    port: backendPort,
    method: req.method,
    path: req.url,
    headers: req.headers,
  });
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/_compat/backend' && req.method === 'POST') {
    const target = req.headers['x-imbox-test-backend'];
    if (!['current', 'historical'].includes(target)) {
      res.writeHead(400);
      res.end();
      return;
    }
    backendPort = target === 'current' ? 4110 : 4111;
    for (const connection of connections) connection.destroy();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ backend: target }));
    return;
  }
  if (path.startsWith('/v1/') || path === '/healthz' || path === '/readyz') {
    const upstream = forwarding(req);
    upstream.on('response', (reply) => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    return;
  }
  const old = (req.headers.cookie ?? '')
    .split(';')
    .some((cookie) => cookie.trim() === `imbox_compat_client=${commit}`);
  if (path === '/_compat/identity') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ client: old ? commit : 'current' }));
    return;
  }
  try {
    const file =
      path.startsWith('/assets/') || extname(path)
        ? decodeURIComponent(path.slice(1))
        : 'index.html';
    if (file.startsWith('/') || file.split('/').includes('..') || file.includes('\\'))
      throw new Error('Invalid static path');
    const body = old ? historicalFiles.get(file) : await readFile(resolve('apps/web/dist', file));
    if (!body) throw new Error('Missing historical file');
    res.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Imbox-Test-Client': old ? commit : 'current',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://127.0.0.1').pathname !== '/v1/ws') {
    socket.destroy();
    return;
  }
  const upstream = forwarding(req);
  upstream.on('upgrade', (reply, target, targetHead) => {
    const headers = [];
    for (let i = 0; i < reply.rawHeaders.length; i += 2)
      headers.push(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}`);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (targetHead.length) socket.write(targetHead);
    if (head.length) target.write(head);
    socket.on('error', () => target.destroy());
    target.on('error', () => socket.destroy());
    connections.add(socket);
    socket.on('close', () => {
      connections.delete(socket);
      target.destroy();
    });
    target.on('close', () => socket.destroy());
    socket.pipe(target);
    target.pipe(socket);
  });
  upstream.on('response', () => socket.destroy());
  upstream.on('error', () => socket.destroy());
  upstream.end();
});
server.listen(4173, '127.0.0.1');
