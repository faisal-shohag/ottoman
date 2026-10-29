// Dev-only test site for the agent. node demo/server.mjs -> http://localhost:5555
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const port = Number(process.env.DEMO_PORT ?? 5555);
const log = [];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL('http://x' + req.url);
  const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').filter(Boolean).map((c) => c.trim().split('=')));

  if (url.pathname === '/api/submit' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let data;
    try { data = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid json' }); }
    const entry = { at: new Date().toISOString(), form: url.searchParams.get('form') ?? 'unknown', data };
    log.push(entry);
    console.log('[submit]', entry.form, JSON.stringify(data));
    return json(res, 200, { ok: true, id: log.length });
  }
  if (url.pathname === '/api/log') {
    if (req.method === 'DELETE') { log.length = 0; return json(res, 200, { ok: true }); }
    return json(res, 200, log);
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let user, pass;
    try { ({ user, pass } = JSON.parse(raw || '{}')); } catch { return json(res, 400, { error: 'invalid json' }); }
    if (user !== 'demo' || pass !== 'demo') return json(res, 401, { error: 'Wrong username or password' });
    res.setHeader('set-cookie', 'session=demo; Path=/; HttpOnly');
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/account.html' && cookies.session !== 'demo') {
    res.writeHead(302, { location: '/login.html?next=/account.html' });
    return res.end();
  }

  // Static files; normalize blocks ../ escapes out of public/.
  const path = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!path.startsWith(root)) return json(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}).listen(port, '127.0.0.1', () => console.log(`demo site on http://localhost:${port}`));
