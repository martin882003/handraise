import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const COOKIE = 'handraise_session';
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIRING_TTL_MS = 5 * 60_000;
const SESSION_TTL_SECONDS = 180 * 24 * 60 * 60;

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');

function equal(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function code() {
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function cookieValue(header = '') {
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return null;
}

function safeName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (name || 'Paired device').slice(0, 80);
}

export class PairingAuth {
  constructor({ root, now = () => Date.now() }) {
    this.root = root;
    this.path = join(root, 'auth.json');
    this.now = now;
    this.pairing = null;
    this.failures = [];
    if (!this.hasDevices()) this.startPairing();
  }

  #read() {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8'));
      return { version: 1, devices: Array.isArray(data.devices) ? data.devices : [] };
    } catch {
      return { version: 1, devices: [] };
    }
  }

  #write(data) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
  }

  devices() {
    return this.#read().devices
      .filter((device) => !device.expiresAt || Date.parse(device.expiresAt) > this.now())
      .map(({ tokenHash: _tokenHash, ...device }) => device);
  }

  hasDevices() {
    return this.#read().devices.some((device) => !device.expiresAt || Date.parse(device.expiresAt) > this.now());
  }

  startPairing() {
    this.pairing = {
      code: code(),
      token: randomBytes(32).toString('base64url'),
      expiresAt: this.now() + PAIRING_TTL_MS,
    };
    return this.pairingDetails();
  }

  pairingDetails() {
    if (!this.pairing || this.pairing.expiresAt <= this.now()) return null;
    return { code: this.pairing.code, token: this.pairing.token, expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }

  authenticate(cookieHeader) {
    const token = cookieValue(cookieHeader);
    if (!token) return null;
    const tokenHash = hash(token);
    const data = this.#read();
    const found = data.devices.find((device) => equal(device.tokenHash, tokenHash));
    if (!found) return null;
    if (found.expiresAt && Date.parse(found.expiresAt) <= this.now()) return null;
    if (!found.expiresAt) {
      found.expiresAt = new Date(this.now() + SESSION_TTL_SECONDS * 1_000).toISOString();
      this.#write(data);
    }
    const seen = Date.parse(found.lastSeenAt || found.createdAt || 0);
    if (!Number.isFinite(seen) || this.now() - seen > 60_000) {
      found.lastSeenAt = new Date(this.now()).toISOString();
      this.#write(data);
    }
    const { tokenHash: _tokenHash, ...device } = found;
    return device;
  }

  pair(value, name) {
    const cutoff = this.now() - 5 * 60_000;
    this.failures = this.failures.filter((time) => time > cutoff);
    if (this.failures.length >= 10) throw new Error('too many pairing attempts; wait five minutes');
    const pairing = this.pairingDetails();
    if (!pairing) {
      if (!this.hasDevices()) this.startPairing();
      throw new Error('the pairing code expired; restart Handraise to print a new code');
    }
    const submitted = String(value || '').trim();
    const accepted = equal(submitted.toUpperCase(), pairing.code) || equal(submitted, pairing.token);
    if (!accepted) {
      this.failures.push(this.now());
      throw new Error('invalid pairing code');
    }

    const token = randomBytes(32).toString('base64url');
    const now = new Date(this.now()).toISOString();
    const device = {
      id: randomUUID(),
      name: safeName(name),
      tokenHash: hash(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(this.now() + SESSION_TTL_SECONDS * 1_000).toISOString(),
    };
    const data = this.#read();
    data.devices.push(device);
    this.#write(data);
    this.pairing = null;
    this.failures = [];
    const { tokenHash: _tokenHash, ...publicDevice } = device;
    return { token, device: publicDevice };
  }

  revoke(id, { allowFinal = false } = {}) {
    const data = this.#read();
    const previous = data.devices.length;
    const active = data.devices.filter((device) => !device.expiresAt || Date.parse(device.expiresAt) > this.now());
    if (!allowFinal && active.length === 1 && active[0].id === id) {
      throw new Error('pair another device before revoking the final active device');
    }
    data.devices = data.devices.filter((device) => device.id !== id);
    if (data.devices.length === previous) throw new Error('device not found');
    this.#write(data);
    return { revoked: id };
  }

  reset() {
    this.#write({ version: 1, devices: [] });
    this.failures = [];
    this.pairing = null;
    return { reset: true };
  }

  cookie(token, { secure = false } = {}) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
  }

  clearCookie({ secure = false } = {}) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

export function createPairingAuth(options) {
  return new PairingAuth(options);
}
