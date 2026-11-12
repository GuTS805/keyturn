// A local stand-in for the Chrome Web Store publish API (v2) and the OAuth
// token endpoint. Unlike a plain mock it checks the CRX3 signature with real
// cryptography, and that the signing key's id is the item id.
//
//   POST /token                                                        refresh token -> access token
//   POST /upload/v2/publishers/:pub/items/:id:upload                   raw CRX3 body
//   GET  /v2/publishers/:pub/items/:id:fetchStatus
//   POST /v2/publishers/:pub/items/:id:publish
//   GET  /service/update2/crx?x=id%3D<id>%26uc                         the live CRX (what clients download)
//
// Mock only:
//   POST /-/mock/artifact           store a ZIP, returns its URL
//   POST /-/mock/tamper-artifact/:id
//   GET  /-/mock/artifacts/:id
//   POST /-/mock/go-live/:id        pretend review passed: the pending upload becomes the live CRX

import http from 'node:http';
import { createHash, createPublicKey, createVerify, randomUUID } from 'node:crypto';
import { crxZip, zipManifestVersion } from '../cli/src/crx.mjs';

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
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

// Minimal protobuf reader for the CRX3 header: returns [{ field, bytes }].
function fields(buf) {
  const out = [];
  let p = 0;
  const varint = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = buf[p++];
      n += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return n;
      shift += 7;
    }
  };
  while (p < buf.length) {
    const tag = varint();
    if ((tag & 7) !== 2) throw new Error('unexpected wire type');
    const len = varint();
    out.push({ field: Math.floor(tag / 8), bytes: buf.subarray(p, p + len) });
    p += len;
  }
  return out;
}

const idFromKey = (spki) =>
  [...createHash('sha256').update(spki).digest().subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');

/** Checks a CRX3 file and returns { id, zip }. Throws when the signature or id is wrong. */
export function checkCrx(crx) {
  const zip = crxZip(crx);
  const header = crx.subarray(12, crx.length - zip.length);
  const top = fields(header);
  const signedHeaderData = top.find((f) => f.field === 10000)?.bytes;
  const proof = top.find((f) => f.field === 2)?.bytes;
  if (!signedHeaderData || !proof) throw new Error('CRX header is incomplete');
  const publicKey = fields(proof).find((f) => f.field === 1).bytes;
  const signature = fields(proof).find((f) => f.field === 2).bytes;
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedHeaderData.length);
  const v = createVerify('sha256');
  v.update(Buffer.concat([Buffer.from('CRX3 SignedData\0'), len, signedHeaderData, zip]));
  if (!v.verify(createPublicKey({ key: publicKey, format: 'der', type: 'spki' }), signature)) {
    throw new Error('bad CRX signature');
  }
  const declared = fields(signedHeaderData).find((f) => f.field === 1)?.bytes;
  const fromKey = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  if (!declared || !declared.equals(fromKey)) throw new Error('CRX id does not match its key');
  return { id: idFromKey(publicKey), zip };
}

export function startChromeStore({ port = 0, refreshToken, publisher = 'publisher-1' }) {
  let origin = '';
  const pending = new Map(); // item id -> { crx, zip, version }
  const live = new Map(); // item id -> crx
  const requested = new Set(); // item ids with a publish request
  const artifacts = new Map();
  const accessTokens = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const path = decodeURIComponent(url.pathname);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      const authed = bearer && accessTokens.has(bearer);

      if (req.method === 'POST' && path === '/token') {
        const form = new URLSearchParams((await readBody(req)).toString());
        if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== refreshToken) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
        }
        const token = 'at-' + randomUUID();
        accessTokens.add(token);
        return json(res, 200, { access_token: token, expires_in: 3600, token_type: 'Bearer' });
      }

      if (req.method === 'POST' && path === '/-/mock/artifact') {
        const body = JSON.parse((await readBody(req)).toString());
        const id = randomUUID();
        artifacts.set(id, Buffer.from(body.zip, 'base64'));
        return json(res, 201, { id, url: `${origin}/-/mock/artifacts/${id}` });
      }
      let m = /^\/-\/mock\/artifacts\/([0-9a-f-]{36})$/.exec(path);
      if (m && req.method === 'GET') {
        const buf = artifacts.get(m[1]);
        if (!buf) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
        return res.end(buf);
      }
      m = /^\/-\/mock\/tamper-artifact\/([0-9a-f-]{36})$/.exec(path);
      if (m && req.method === 'POST') {
        artifacts.set(m[1], Buffer.from(JSON.parse((await readBody(req)).toString()).zip, 'base64'));
        return json(res, 200, { ok: true });
      }
      m = /^\/-\/mock\/go-live\/([a-p]{32})$/.exec(path);
      if (m && req.method === 'POST') {
        const p = pending.get(m[1]);
        if (!p || !requested.has(m[1])) return json(res, 409, { error: 'nothing was submitted for review' });
        live.set(m[1], p.crx);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && path === '/service/update2/crx') {
        const id = /id=([a-p]{32})/.exec(url.searchParams.get('x') || '')?.[1];
        const crx = id && live.get(id);
        if (!crx) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': 'application/x-chrome-extension', 'content-length': crx.length });
        return res.end(crx);
      }

      m = /^\/(?:upload\/)?v2\/publishers\/([\w-]+)\/items\/([a-p]{32}):(upload|fetchStatus|publish)$/.exec(path);
      if (m) {
        const [, pub, id, action] = m;
        if (!authed) return json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
        if (pub !== publisher) return json(res, 403, { error: { code: 403, message: 'Unknown publisher' } });
        if (action === 'upload' && req.method === 'POST') {
          const body = await readBody(req);
          if (req.headers['x-goog-upload-protocol'] !== 'raw') {
            return json(res, 400, { error: { code: 400, message: 'raw upload expected' } });
          }
          let checked;
          try {
            checked = checkCrx(body);
          } catch (e) {
            return json(res, 200, { itemId: id, uploadState: 'FAILED', error: String(e.message) });
          }
          if (checked.id !== id) {
            return json(res, 200, { itemId: id, uploadState: 'FAILED', error: 'CRX is signed by a different key than this item' });
          }
          const version = zipManifestVersion(checked.zip);
          pending.set(id, { crx: body, zip: checked.zip, version });
          return json(res, 200, { itemId: id, crxVersion: version, uploadState: 'SUCCEEDED' });
        }
        if (action === 'fetchStatus' && req.method === 'GET') {
          return json(res, 200, { itemId: id, lastAsyncUploadState: pending.has(id) ? 'SUCCEEDED' : 'NOT_FOUND' });
        }
        if (action === 'publish' && req.method === 'POST') {
          if (!pending.has(id)) return json(res, 400, { error: { code: 400, message: 'no uploaded package' } });
          requested.add(id);
          return json(res, 200, { itemId: id, state: 'PENDING_REVIEW' });
        }
      }
      json(res, 404, { error: { code: 404, message: 'not found' } });
    } catch (e) {
      json(res, 500, { error: { code: 500, message: String(e.message || e) } });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: origin,
        publisher,
        close: () => new Promise((r) => server.close(r)),
        isLive: (id) => live.has(id),
        isPending: (id) => pending.has(id),
        pendingVersion: (id) => pending.get(id)?.version,
      });
    });
  });
}
