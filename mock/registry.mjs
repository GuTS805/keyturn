// A local stand-in for the npm registry's staged publishing API.
//
// It follows the endpoints used by the npm CLI (`npm stage ...`):
//   GET    /-/stage                    list staged packages
//   GET    /-/stage/:id                one staged package
//   GET    /-/stage/:id/tarball        its tarball
//   POST   /-/stage/:id/approve        publish it (needs a one-time password)
//   DELETE /-/stage/:id                reject it   (needs a one-time password)
//   GET    /:name/:version             published version metadata
//
//   PUT    /:name                      direct publish (bot token only, like a read-write token)
//
// These are mock only, and are prefixed with /-/mock/:
//   POST /-/mock/stage                 stands in for `npm stage publish`
//   POST /-/mock/tamper/:id            swaps the staged bytes, to simulate a tampered build
//   POST /-/mock/artifact              stores a build artifact, returns its URL
//   GET  /-/mock/artifacts/:id         serves it without credentials
//   POST /-/mock/tamper-artifact/:id   swaps the artifact bytes
//
// Two credentials exist. The bot token can approve with a valid one-time
// password. The CI token can only stage, like a trusted publishing identity.

import http from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readTgz } from './tarball.mjs';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text) {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = '';
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error('bad base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, nowSeconds = Math.floor(Date.now() / 1000), step = 0) {
  const counter = Math.floor(nowSeconds / 30) + step;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = mac[19] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

function bytes(res, status, buf) {
  res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
  res.end(buf);
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const sha512b64 = (b) => 'sha512-' + createHash('sha512').update(b).digest('base64');

export function startRegistry({ port = 0, botToken, ciToken, totpSecret, now = () => Math.floor(Date.now() / 1000) }) {
  const staged = new Map(); // id -> { id, name, version, tarball, createdAt }
  const published = new Map(); // name -> Map(version -> { tarball })
  const artifacts = new Map(); // id -> Buffer
  let origin = '';

  const role = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    if (m[1] === botToken) return 'bot';
    if (m[1] === ciToken) return 'ci';
    return null;
  };

  const otpOk = (req) => {
    const code = req.headers['npm-otp'];
    if (!code) return false;
    return [-1, 0, 1].some((s) => totp(totpSecret, now(), s) === code);
  };

  const view = (s) => ({ id: s.id, name: s.name, version: s.version, createdAt: s.createdAt, size: s.tarball.length });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const path = decodeURIComponent(url.pathname);
      const who = role(req);

      if (req.method === 'POST' && path === '/-/mock/stage') {
        if (!who) return json(res, 401, { error: 'unauthorized' });
        const body = JSON.parse((await readBody(req)).toString());
        const tarball = Buffer.from(body.tarball, 'base64');
        const manifest = JSON.parse(readTgz(tarball)['package/package.json'].toString());
        if (manifest.name !== body.name || manifest.version !== body.version) {
          return json(res, 400, { error: 'package.json does not match the request' });
        }
        if (published.get(body.name)?.has(body.version)) return json(res, 409, { error: 'version already published' });
        const id = randomUUID();
        staged.set(id, { id, name: body.name, version: body.version, tarball, createdAt: new Date().toISOString() });
        return json(res, 201, { id });
      }

      if (req.method === 'POST' && path === '/-/mock/artifact') {
        if (!who) return json(res, 401, { error: 'unauthorized' });
        const body = JSON.parse((await readBody(req)).toString());
        const id = randomUUID();
        artifacts.set(id, Buffer.from(body.tarball, 'base64'));
        return json(res, 201, { id, url: `${origin}/-/mock/artifacts/${id}` });
      }

      let m = /^\/-\/mock\/artifacts\/([0-9a-f-]{36})$/.exec(path);
      if (m && req.method === 'GET') {
        const buf = artifacts.get(m[1]);
        return buf ? bytes(res, 200, buf) : json(res, 404, { error: 'not found' });
      }

      m = /^\/-\/mock\/tamper-artifact\/([0-9a-f-]{36})$/.exec(path);
      if (m && req.method === 'POST') {
        if (!artifacts.has(m[1])) return json(res, 404, { error: 'not found' });
        artifacts.set(m[1], Buffer.from(JSON.parse((await readBody(req)).toString()).tarball, 'base64'));
        return json(res, 200, { ok: true });
      }

      m = /^\/-\/mock\/tamper\/([0-9a-f-]{36})$/.exec(path);
      if (m && req.method === 'POST') {
        const item = staged.get(m[1]);
        if (!item) return json(res, 404, { error: 'not found' });
        item.tarball = Buffer.from(JSON.parse((await readBody(req)).toString()).tarball, 'base64');
        return json(res, 200, { ok: true });
      }

      if (path === '/-/stage' && req.method === 'GET') {
        if (!who) return json(res, 401, { error: 'unauthorized' });
        const filter = url.searchParams.get('package');
        const items = [...staged.values()].filter((s) => !filter || s.name === filter).map(view);
        return json(res, 200, { items, total: items.length });
      }

      m = /^\/-\/stage\/([0-9a-f-]{36})(\/tarball|\/approve)?$/.exec(path);
      if (m) {
        if (!who) return json(res, 401, { error: 'unauthorized' });
        const item = staged.get(m[1]);
        if (!item) return json(res, 404, { error: 'not found' });
        if (req.method === 'GET' && !m[2]) return json(res, 200, view(item));
        if (req.method === 'GET' && m[2] === '/tarball') return bytes(res, 200, item.tarball);
        if (req.method === 'POST' && m[2] === '/approve') {
          if (who !== 'bot') return json(res, 403, { error: 'stage-only credentials cannot approve' });
          if (!otpOk(req)) return json(res, 401, { code: 'EOTP', error: 'one-time password required' });
          if (!published.has(item.name)) published.set(item.name, new Map());
          published.get(item.name).set(item.version, { tarball: item.tarball });
          staged.delete(item.id);
          return json(res, 200, {});
        }
        if (req.method === 'DELETE' && !m[2]) {
          if (who !== 'bot') return json(res, 403, { error: 'stage-only credentials cannot reject' });
          if (!otpOk(req)) return json(res, 401, { code: 'EOTP', error: 'one-time password required' });
          staged.delete(item.id);
          res.writeHead(204).end();
          return;
        }
      }

      m = /^\/((?:@[^/]+\/)?[^/@][^/]*)$/.exec(path);
      if (m && req.method === 'PUT' && !path.startsWith('/-/')) {
        if (!who) return json(res, 401, { error: 'unauthorized' });
        if (who !== 'bot') return json(res, 403, { error: 'stage-only credentials cannot publish directly' });
        const doc = JSON.parse((await readBody(req)).toString());
        const name = m[1];
        if (doc.name !== name) return json(res, 400, { error: 'name does not match the URL' });
        for (const [version, vdoc] of Object.entries(doc.versions || {})) {
          const att = doc._attachments?.[`${name}-${version}.tgz`];
          if (!att) return json(res, 400, { error: 'missing attachment' });
          const tarball = Buffer.from(att.data, 'base64');
          if (tarball.length !== att.length) return json(res, 400, { error: 'attachment length mismatch' });
          if (sha1(tarball) !== vdoc.dist?.shasum || sha512b64(tarball) !== vdoc.dist?.integrity) {
            return json(res, 400, { error: 'integrity does not match the attachment' });
          }
          const manifest = JSON.parse(readTgz(tarball)['package/package.json'].toString());
          if (manifest.name !== name || manifest.version !== version) {
            return json(res, 400, { error: 'package.json does not match the request' });
          }
          if (published.get(name)?.has(version)) {
            return json(res, 403, { error: `You cannot publish over the previously published versions: ${version}.` });
          }
          if (!published.has(name)) published.set(name, new Map());
          published.get(name).set(version, { tarball });
        }
        return json(res, 200, { ok: true });
      }

      m = /^\/-\/tarballs\/(.+)\/([^/]+)\.tgz$/.exec(path);
      if (m && req.method === 'GET') {
        const entry = published.get(m[1])?.get(m[2]);
        return entry ? bytes(res, 200, entry.tarball) : json(res, 404, { error: 'not found' });
      }

      m = /^\/((?:@[^/]+\/)?[^/@][^/]*)\/([^/]+)$/.exec(path);
      if (m && req.method === 'GET' && !path.startsWith('/-/')) {
        const entry = published.get(m[1])?.get(m[2]);
        if (!entry) return json(res, 404, { error: 'not found' });
        return json(res, 200, {
          name: m[1],
          version: m[2],
          dist: {
            tarball: `${origin}/-/tarballs/${m[1]}/${m[2]}.tgz`,
            shasum: sha1(entry.tarball),
            integrity: sha512b64(entry.tarball),
          },
        });
      }

      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: origin,
        close: () => new Promise((r) => server.close(r)),
        isPublished: (name, version) => Boolean(published.get(name)?.has(version)),
        publishedTarball: (name, version) => published.get(name)?.get(version)?.tarball,
        stagedCount: () => staged.size,
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const botToken = process.env.MOCK_BOT_TOKEN || 'bot-token';
  const ciToken = process.env.MOCK_CI_TOKEN || 'ci-token';
  const totpSecret = process.env.MOCK_TOTP_SECRET || 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const reg = await startRegistry({ port: Number(process.env.PORT || 4873), botToken, ciToken, totpSecret });
  console.log(`mock npm registry on ${reg.url}`);
}
