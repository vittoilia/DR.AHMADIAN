/* The academy as a plain Node server — for local development, a VPS, or a
   cPanel host with "Setup Node.js App" (startup file: app.cjs).

   Serves dist/ (built assets) directly and everything else through the same
   handler the Netlify function uses (src/server/app.mjs). Settings come from
   the environment, or from a .env file next to this one. */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
// relative paths (data/, .env) are relative to the app, whatever the host's working directory
process.chdir(ROOT);

// .env (KEY=value lines) for hosts that do not set environment variables
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { handle } = await import('./src/server/app.mjs');
const { config } = await import('./src/server/config.mjs');
const { staticHeaders } = await import('./src/server/security/static.mjs');

const DIST = join(ROOT, 'dist');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const MAX_BODY = 6 * 1024 * 1024;

async function serveStatic(pathname, res, head) {
  if (pathname === '/' || pathname.includes('\0')) return false;
  let p;
  try { p = normalize(join(DIST, decodeURIComponent(pathname))); } catch { return false; }
  if (!p.startsWith(DIST + sep) || p.endsWith('_headers')) return false;
  try {
    const s = await stat(p);
    if (!s.isFile()) return false;
    const body = await readFile(p);
    const type = TYPES[extname(p).toLowerCase()];
    if (!type) return false;
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, ...staticHeaders(pathname) });
    res.end(head ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(url.pathname, res, req.method === 'HEAD'))) return;

    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
    const chunks = [];
    let size = 0;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
        chunks.push(c);
      }
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'x-academy-socket-ip') continue; // never trust a client-sent value
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v !== undefined) headers.set(k, v);
    }
    headers.set('x-academy-socket-ip', req.socket.remoteAddress || '0.0.0.0');
    const origin = config.siteUrl;
    const request = new Request(new URL(req.url, origin), { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const { clientIp } = await import('./src/server/util/http.mjs');
    const response = await handle(request, { ip: clientIp(request, config.trustProxy) });
    const out = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') out[k] = v; });
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out);
    if (response.body && req.method !== 'HEAD') {
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } else res.end();
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  }
});

server.headersTimeout = 20000;
server.requestTimeout = 60000;
server.keepAliveTimeout = 5000;

const port = Number(process.env.PORT || config.port);
server.listen(port, process.env.PORT ? undefined : config.host, () => {
  console.log(`[academy] ${config.production ? 'production' : 'development'} · ${config.dbDriver} · ${config.storageDriver} · ${config.siteUrl} (listening on ${port})`);
  if (config.adminPath && !config.production) console.log(`[academy] admin: ${config.siteUrl}/${config.adminPath}/`);
});
