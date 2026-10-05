// Launchpad token images: validation, IPFS pinning (Pinata) and an honest
// self-hosted fallback.
//
// A launchpad RAM's token needs an image: pump.fun, wallets and explorers
// read the `image` field of the token's metadata JSON to show a logo. The
// entry slip uploads the picked file here (POST /api/launchpad/images, the
// raw bytes as the request body) BEFORE the draft is created, because the
// metadata JSON is pinned immutably at draft time and must already carry the
// image URL.
//
//   Pinata configured and under its image cap -> the bytes are pinned with
//     pinFileToIPFS and the image URL is the real gateway URL. Nothing is
//     kept in memory.
//   Pinata unset, over the cap, or the pin failed -> the bytes are held in
//     memory (bounded, see DEFAULT_MAX_HELD_IMAGE_BYTES) and served by this
//     server at /api/launchpad/images/<id>, the same way metadata.json is
//     self-hosted when it can't be pinned. Like every other record here it is
//     lost on a restart; a held image that was evicted is simply left out of
//     the metadata rather than pointing at a 404.
//
// Image ids are content-addressed (sha256 of the bytes), so uploading the same
// file twice never pins it twice.

import { createHash } from 'node:crypto';
import { createRateLimiter } from './ratelimit.js';

/**
 * Our own per-image ceiling: 2 MB. pump.fun's create form allows up to 15 MB
 * ("Image - max 15MB. Recommended: .jpg, .gif, .png"; "min 1000x1000px,
 * 1:1 recommended", pump.fun help centre, "Create a coin on Pump.fun"), so
 * this is stricter than pump.fun on purpose: the upload goes through this
 * server (a 256 MB Fly machine) and, when it can't be pinned, is held in its
 * memory; and every pin counts against the operator's Pinata storage quota.
 * A 1000x1000 JPG or WEBP is typically a few hundred KB, well inside it.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** The image types accepted, by their real file signature (never by the declared type). */
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' });

export const IMAGE_ID_RE = /^img-[0-9a-f]{24}$/;

// Global cap on image pins, separate from the metadata-JSON cap in rams.js
// (DEFAULT_PIN_RATE_LIMIT, 20/hour). An image is up to 2 MB against the same
// Pinata account's storage, where a metadata JSON is under 1 KB, so the image
// rate is set lower: 10/hour bounds a flood to ~20 MB/hour of pinned storage.
// Every real draft needs exactly one image, so 10 launches an hour is still
// far above real use while the launchpad isn't live. Past the cap an upload
// still succeeds; it is self-hosted instead, exactly like a metadata pin over
// its cap.
export const DEFAULT_IMAGE_PIN_RATE_LIMIT = Object.freeze({ max: 10, windowMs: 60 * 60 * 1000 });

// Bytes held in memory for self-hosted (unpinned) images, all together. 16 MB
// is 8 max-size images: enough for the fallback path, small next to the
// 256 MB production machine. Past it the oldest image no draft uses is
// dropped first, then the oldest one only a draft uses; an image claimed by
// an active (launched) RAM is never dropped. If nothing can be dropped the
// upload is refused (503) instead of growing memory.
export const DEFAULT_MAX_HELD_IMAGE_BYTES = 16 * 1024 * 1024;

export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The real image type from the file's first bytes, or null. */
export function sniffImageType(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const head6 = Buffer.from(b.subarray(0, 6)).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ ok: true, type: string } | { ok: false, code: string, reason: string }}
 */
export function validateImageBytes(bytes) {
  if (!bytes || bytes.length === 0) return { ok: false, code: 'invalid_image', reason: 'Pick an image file for the token.' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, code: 'too_large', reason: `The image must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller.` };
  const type = sniffImageType(bytes);
  if (!type) return { ok: false, code: 'invalid_image', reason: 'That file is not a PNG, JPG, GIF or WEBP image.' };
  return { ok: true, type };
}

export function imageIdFor(bytes) {
  return `img-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`;
}

/**
 * @param {{
 *   publicBaseUrl: string,
 *   pinata?: { pinFile: Function } | null,
 *   pinRateLimit?: { max: number, windowMs: number },
 *   maxHeldBytes?: number,
 *   now?: () => string,
 * }} opts
 */
export function createImageStore({ publicBaseUrl, pinata = null, pinRateLimit = DEFAULT_IMAGE_PIN_RATE_LIMIT, maxHeldBytes = DEFAULT_MAX_HELD_IMAGE_BYTES, now = () => new Date().toISOString() }) {
  const base = publicBaseUrl.replace(/\/+$/, '');
  /** @type {Map<string, { id: string, type: string, size: number, url: string, cid: string|null, pinned: boolean, bytes: Buffer|null, use: 'loose'|'drafted'|'kept', createdAt: string }>} */
  const images = new Map();
  /** in-flight uploads by id, so two identical uploads at once pin once */
  const inflight = new Map();
  const pinLimiter = pinata ? createRateLimiter({ ...pinRateLimit, countDenied: false }) : null;
  let heldBytes = 0;

  const info = (img) => ({ id: img.id, type: img.type, size: img.size, url: img.url, pinned: img.pinned, ...(img.cid ? { cid: img.cid } : {}) });

  function drop(img) {
    if (img.bytes) heldBytes -= img.bytes.length;
    images.delete(img.id);
  }

  /** Frees room for `size` held bytes. Returns false if only kept images are left. */
  function makeRoom(size) {
    for (const use of ['loose', 'drafted']) {
      for (const img of [...images.values()]) {
        if (heldBytes + size <= maxHeldBytes) return true;
        if (img.bytes && img.use === use) drop(img);
      }
    }
    return heldBytes + size <= maxHeldBytes;
  }

  async function pin(id, buf, type) {
    try {
      const { cid, uri } = await pinata.pinFile(buf, { name: `${id}.${EXT[type]}`, type, filename: `${id}.${EXT[type]}` });
      const img = { id, type, size: buf.length, url: uri, cid, pinned: true, bytes: null, use: 'loose', createdAt: now() };
      images.set(id, img);
      return info(img);
    } catch {
      // Pinata failed: hold it here instead, same as a failed metadata pin.
      return hold(id, buf, type);
    }
  }

  /** Synchronous on purpose: with no pin to wait for, the image is usable the moment upload() returns. */
  function hold(id, buf, type) {
    if (!makeRoom(buf.length)) throw new ImageError('image_storage_full', 'The server cannot hold another image right now. Please try again later.');
    const img = { id, type, size: buf.length, url: `${base}/api/launchpad/images/${id}`, cid: null, pinned: false, bytes: buf, use: 'loose', createdAt: now() };
    images.set(id, img);
    heldBytes += buf.length;
    return info(img);
  }

  /**
   * Validates and stores an image. Throws ImageError (code invalid_image /
   * too_large / image_storage_full) on a refusal; never returns a fake URL.
   * With no pin attempted (Pinata unset or over its cap) the image is held
   * before this returns, so get(id) works without awaiting.
   * @param {Buffer|Uint8Array} bytes
   * @returns {Promise<{ id: string, type: string, size: number, url: string, pinned: boolean, cid?: string }>}
   */
  function upload(bytes) {
    try {
      const verdict = validateImageBytes(bytes);
      if (!verdict.ok) throw new ImageError(verdict.code, verdict.reason);
      const buf = Buffer.from(bytes);
      const id = imageIdFor(buf);
      if (images.has(id)) return Promise.resolve(info(images.get(id)));
      if (inflight.has(id)) return inflight.get(id);
      if (!(pinata && pinLimiter.hit('pinata-image').allowed)) return Promise.resolve(hold(id, buf, verdict.type));
      const p = pin(id, buf, verdict.type).finally(() => inflight.delete(id));
      inflight.set(id, p);
      return p;
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function get(id) {
    const img = typeof id === 'string' ? images.get(id) : undefined;
    return img ? info(img) : undefined;
  }

  /** Bytes for serving a self-hosted image; undefined for a pinned or unknown one. */
  function file(id) {
    const img = images.get(id);
    return img && img.bytes ? { type: img.type, bytes: img.bytes } : undefined;
  }

  /** A draft uses this image ('drafted'), or an active RAM does ('kept', never dropped). */
  function claim(id, use) {
    const img = images.get(id);
    if (!img) return;
    if (use === 'kept' || img.use === 'loose') img.use = use;
  }

  return { upload, get, file, claim, heldBytes: () => heldBytes, stop: () => pinLimiter?.stop() };
}
