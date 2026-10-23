import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Passwords: scrypt with a random salt, stored as "scrypt$<salt>$<hash>".
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// API keys: shown once, only the SHA-256 hash and a display prefix are stored.
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `mcpg_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

// Upstream credentials: AES-256-GCM, key derived from the master key Secret.
const aesKey = createHash('sha256').update(config.masterKey).digest();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('unknown credential format');
  const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
