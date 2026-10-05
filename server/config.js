import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function int(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// Reads settings from the environment. Anything in `overrides` wins (used by tests).
export function loadConfig(env = process.env, overrides = {}) {
  return {
    port: int(env.PORT, 4700, { max: 65535 }),
    host: env.HOST || '127.0.0.1',
    // Dev-only default so the admin routes work out of the box locally;
    // set ADMIN_TOKEN in production. Requests must send it as
    // `x-admin-token`.
    adminToken: env.ADMIN_TOKEN || 'dev-admin-token',
    budget: {
      usdPerSlot: num(env.RAMHERD_USD_PER_SLOT, 5, { min: 0.01 }),
      allocationFraction: num(env.RAMHERD_ALLOCATION_FRACTION, 1, { min: 0, max: 1 }),
      minSlots: int(env.RAMHERD_MIN_SLOTS, 0),
      maxSlots: int(env.RAMHERD_MAX_SLOTS, 12),
    },
    ideaRateLimit: { max: 5, windowMs: 10 * 60 * 1000 },
    maxBodyBytes: 8192,
    trustProxy: int(env.TRUST_PROXY, 0, { max: 10 }),
    log: (line) => console.log(line),
    ...overrides,
  };
}

// Loads .env from the project root if there is one. Real environment variables win.
export function loadDotEnv() {
  const file = resolve(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
