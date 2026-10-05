// Pinata (IPFS pinning), for a launchpad RAM's token metadata JSON and its
// token image.
//
// Off by default: `pinataPolicy(env)` is the one place `PINATA_JWT` is read,
// and `createPinataClient` is only ever constructed when it's set. Nothing
// here is reachable with no key configured.
//
// `pinJson` throws on any real failure (network, auth, rate limit) rather
// than returning a fake/placeholder URL -- the caller (rams.js) decides what
// to fall back to. This module never guesses a CID.

const PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
// Same legacy pinning API as pinJSONToIPFS, but multipart/form-data: a
// required `file` part, plus optional `pinataMetadata` / `pinataOptions`
// parts that are JSON *strings* (docs.pinata.cloud, "Pin File"). The response
// is { IpfsHash, PinSize, Timestamp, isDuplicate }.
const PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
// DELETE, CID in the path; answers 200 with a plain-text "OK".
const UNPIN_URL = 'https://api.pinata.cloud/pinning/unpin/';
const GATEWAY = 'https://gateway.pinata.cloud/ipfs/';

/** @param {NodeJS.ProcessEnv} [env] */
export function pinataPolicy(env = process.env) {
  const jwt = String(env.PINATA_JWT || '').trim();
  return { configured: Boolean(jwt), jwt };
}

/**
 * @param {{ jwt: string, fetchImpl?: typeof fetch }} opts
 */
export function createPinataClient({ jwt, fetchImpl = fetch }) {
  if (!jwt) throw new TypeError('createPinataClient requires a jwt');
  return {
    kind: 'pinata',
    /**
     * Pins a JSON object to IPFS. @returns {Promise<{ cid: string, uri: string }>}
     * @param {object} content
     * @param {{ name?: string }} [opts]
     */
    async pinJson(content, { name } = {}) {
      const res = await fetchImpl(PIN_JSON_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pinataContent: content,
          ...(name ? { pinataMetadata: { name } } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`pinata pinJSONToIPFS failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      if (!data || typeof data.IpfsHash !== 'string' || !data.IpfsHash) {
        throw new Error('pinata response had no IpfsHash');
      }
      return { cid: data.IpfsHash, uri: `${GATEWAY}${data.IpfsHash}` };
    },

    /**
     * Pins one file (raw bytes) to IPFS. @returns {Promise<{ cid: string, uri: string }>}
     * Node 20's built-in FormData/Blob build the multipart body; no
     * Content-Type header is set by hand, so fetch writes the boundary itself.
     * @param {Buffer|Uint8Array} bytes
     * @param {{ name?: string, type?: string, filename?: string }} [opts]
     */
    async pinFile(bytes, { name, type = 'application/octet-stream', filename } = {}) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), filename || name || 'file');
      if (name) form.append('pinataMetadata', JSON.stringify({ name }));
      const res = await fetchImpl(PIN_FILE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
        body: form,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`pinata pinFileToIPFS failed: ${res.status} ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      if (!data || typeof data.IpfsHash !== 'string' || !data.IpfsHash) {
        throw new Error('pinata response had no IpfsHash');
      }
      return { cid: data.IpfsHash, uri: `${GATEWAY}${data.IpfsHash}` };
    },

    /** Removes a pin (operator cleanup; nothing in the app calls it). Throws on failure. */
    async unpin(cid) {
      if (typeof cid !== 'string' || !/^[A-Za-z0-9]+$/.test(cid)) throw new TypeError('unpin needs a CID');
      const res = await fetchImpl(`${UNPIN_URL}${cid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`pinata unpin failed: ${res.status} ${body.slice(0, 200)}`);
      }
    },
  };
}
