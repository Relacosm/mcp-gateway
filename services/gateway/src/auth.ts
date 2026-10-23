import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { query } from './db.js';
import { newToken, sha256 } from './security.js';

export type Role = 'admin' | 'member';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const COOKIE = 'sid';

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export async function startSession(res: Response, userId: number): Promise<void> {
  const token = newToken();
  const maxAge = config.sessionTtlHours * 3600;
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`, [
    sha256(token),
    userId,
    maxAge,
  ]);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`,
  );
}

export async function endSession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, COOKIE);
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Dashboard requests: resolves the session cookie to a user, if any. */
export async function sessionUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = readCookie(req, COOKIE);
  if (token) {
    const [user] = await query<User>(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    req.user = user;
  }
  next();
}

/** MCP clients: resolves "Authorization: Bearer <api key>" to a user. Revoked keys fail immediately. */
export async function apiKeyUser(req: Request): Promise<{ user: User; keyId: number } | undefined> {
  const header = req.headers.authorization ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) return undefined;
  const [row] = await query<User & { key_id: number }>(
    `SELECT u.id, u.email, u.name, u.role, k.id AS key_id FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [sha256(key)],
  );
  if (!row) return undefined;
  void query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]).catch(() => undefined);
  return { user: { id: row.id, email: row.email, name: row.name, role: row.role }, keyId: row.key_id };
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new HttpError(401, 'not logged in');
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new HttpError(401, 'not logged in');
  if (req.user.role !== 'admin') throw new HttpError(403, 'admin only');
  next();
}
