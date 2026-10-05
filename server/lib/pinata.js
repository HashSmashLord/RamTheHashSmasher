// Pinata (IPFS pinning), for a launchpad RAM's token metadata JSON.
//
// Off by default: `pinataPolicy(env)` is the one place `PINATA_JWT` is read,
// and `createPinataClient` is only ever constructed when it's set. Nothing
// here is reachable with no key configured.
//
// `pinJson` throws on any real failure (network, auth, rate limit) rather
// than returning a fake/placeholder URL -- the caller (rams.js) decides what
// to fall back to. This module never guesses a CID.

const PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';
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
  };
}
