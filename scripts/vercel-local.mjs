#!/usr/bin/env node
// Serves .vercel/output (from scripts/vercel-build.mjs) the way Vercel would, with plain node:http:
// config.json routes in order, static files from static/, and the api.func handler imported as Vercel's Node launcher
// does (default export called with IncomingMessage / ServerResponse).
//
//   DATABASE_URL=... JWT_SECRET=... node scripts/vercel-local.mjs [--port 3400]
//   DATABASE_URL=... JWT_SECRET=... node scripts/vercel-local.mjs --smoke    # login + POS sale, then exit
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.VERCEL_OUTPUT_DIR ?? path.join(ROOT, '.vercel/output'));
const args = process.argv.slice(2);
const smoke = args.includes('--smoke');
const portArg = args.includes('--port') ? args[args.indexOf('--port') + 1] : undefined;
const port = Number(portArg ?? process.env.PORT ?? (smoke ? 0 : 3400));

if (!existsSync(path.join(OUT, 'config.json'))) {
  console.error('run node scripts/vercel-build.mjs first');
  process.exit(2);
}
const config = JSON.parse(readFileSync(path.join(OUT, 'config.json'), 'utf8'));
const functions = new Map();
async function fn(name) {
  if (!functions.has(name)) {
    const dir = path.join(OUT, 'functions', `${name.replace(/^\//, '')}.func`);
    const vc = JSON.parse(readFileSync(path.join(dir, '.vc-config.json'), 'utf8'));
    Object.assign(process.env, vc.environment ?? {});
    functions.set(name, (await import(pathToFileURL(path.join(dir, vc.handler)).href)).default);
  }
  return functions.get(name);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function staticFile(p) {
  const f = path.join(OUT, 'static', decodeURIComponent(p));
  if (!f.startsWith(path.join(OUT, 'static'))) return null;
  if (existsSync(f) && statSync(f).isFile()) return f;
  if (existsSync(path.join(f, 'index.html'))) return path.join(f, 'index.html');
  return null;
}
function sendFile(res, f, headers) {
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream', ...headers });
  createReadStream(f).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://x').pathname;
    const headers = {};
    let filesystemDone = false;
    for (const r of config.routes) {
      if (r.handle === 'filesystem') {
        filesystemDone = true;
        const f = staticFile(pathname);
        if (f) return sendFile(res, f, headers);
        continue;
      }
      const m = new RegExp(r.src).exec(pathname);
      if (!m) continue;
      Object.assign(headers, r.headers ?? {});
      if (r.continue) continue;
      if (!r.dest) continue;
      const dest = r.dest.replace(/\$(\d+)/g, (_, i) => m[Number(i)] ?? '');
      const fnDir = path.join(OUT, 'functions', `${dest.replace(/^\//, '')}.func`);
      if (existsSync(fnDir)) {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        return (await fn(dest))(req, res); // req.url stays the original URL, as on Vercel
      }
      const f = staticFile(dest);
      if (f) return sendFile(res, f, headers);
    }
    if (!filesystemDone) {
      const f = staticFile(pathname);
      if (f) return sendFile(res, f, headers);
    }
    res.writeHead(404).end('not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500).end('harness error');
  }
});

await new Promise((r) => server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`[vercel-local] ${base}`);

if (smoke) {
  const ok = (cond, msg) => {
    if (!cond) throw new Error(`smoke: ${msg}`);
    console.log(`  ok  ${msg}`);
  };
  const call = async (method, url, body, token) => {
    const r = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: r.status, json, text, type: r.headers.get('content-type') ?? '' };
  };
  try {
    const health = await call('GET', '/healthz');
    ok(health.status === 200 && health.json.edition === 'cloud', `GET /healthz -> 200 cloud (${health.text})`);
    const meta = await call('GET', '/api/meta?shop=charoen');
    ok(meta.json?.capabilities?.promptPlusOrders === true && meta.json.shop.name === 'ร้านวัสดุเจริญชัย', 'GET /api/meta: cloud capabilities, demo shop');
    const index = await call('GET', '/');
    ok(index.type.startsWith('text/html') && index.text.includes('<div id="root">'), 'GET / -> index.html');
    const spa = await call('GET', '/pos');
    ok(spa.type.startsWith('text/html') && spa.text.includes('<div id="root">'), 'GET /pos -> SPA fallback');
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(index.text)?.[1];
    ok(asset && (await fetch(base + asset)).headers.get('content-type')?.includes('javascript'), `static asset ${asset}`);
    const missing = await call('GET', '/api/nope');
    ok(missing.status === 404 && missing.json?.code === 'NOT_FOUND', 'unknown /api route -> JSON 404');

    const login = await call('POST', '/api/auth/login', { username: 'prae', password: '1234' });
    ok(login.status === 200 && login.json.token, 'login prae (cashier)');
    const t = login.json.token;
    let shift = (await call('GET', '/api/shifts/current', null, t)).json;
    if (!shift) shift = (await call('POST', '/api/shifts/open', { float: '1000.00', deviceId: 'POS-VERCEL' }, t)).json;
    ok(shift?.id, `shift ${shift.no}`);
    const wh = (await call('GET', '/api/warehouses', null, t)).json.items.find((w) => w.isPos);
    const products = (await call('GET', '/api/products?limit=100', null, t)).json.items;
    const stock = (await call('GET', `/api/stock?limit=100`, null, t)).json.items;
    const p = products.find((x) => x.kind === 'stock' && stock.some((s) => s.productId === x.id && s.warehouseId === wh.id && Number(s.qty) >= 1));
    ok(p, `product with stock in ${wh.name}: ${p.sku} @ ${p.price}`);
    const sale = await call('POST', '/api/sales/pos', {
      idempotencyKey: randomUUID(), shiftId: shift.id, warehouseId: wh.id, docKind: 'abb',
      lines: [{ productId: p.id, unitIdx: 0, qty: '1', unitPrice: p.price }],
      payments: [{ method: 'cash', amount: p.price }],
    }, t);
    ok(sale.status === 201 && sale.json?.no, `POS sale ${sale.json?.no} total ${sale.json?.totals?.total} (${sale.status})`);
    const doc = await call('GET', `/api/sales/docs/${encodeURIComponent(sale.json.no)}`, null, t);
    ok(doc.status === 200 && doc.json.no === sale.json.no, 'GET the sale document back');
    console.log('[vercel-local] smoke passed');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    server.close();
    process.exit();
  }
}
