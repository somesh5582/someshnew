import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';

const scrypt = promisify(scryptCallback);
const SESSION_DAYS = Number.isFinite(Number(process.env.SESSION_DAYS))
  ? Math.max(1, Math.min(30, Number(process.env.SESSION_DAYS)))
  : 7;
export const SESSION_COOKIE = 'csr_agro_session';

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedHex] = String(storedHash).split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = await scrypt(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

export function findUserForLogin(username) {
  return db.prepare(`
    SELECT
      id, username, display_name AS displayName, password_hash AS passwordHash,
      role, is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt
    FROM users
    WHERE username = ? COLLATE NOCASE
  `).get(username);
}

export function listUsers() {
  return db.prepare(`
    SELECT
      id, username, display_name AS displayName, role,
      is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt
    FROM users
    ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username COLLATE NOCASE
  `).all().map(publicUser);
}

export function getUser(id) {
  return publicUser(db.prepare(`
    SELECT
      id, username, display_name AS displayName, role,
      is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt
    FROM users
    WHERE id = ?
  `).get(id));
}

export function insertUser({ username, displayName, passwordHash, role }) {
  let result;
  try {
    result = db.prepare(`
      INSERT INTO users (username, display_name, password_hash, role)
      VALUES (@username, @displayName, @passwordHash, @role)
    `).run({ username, displayName, passwordHash, role });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      error.message = 'A user with this username already exists.';
      error.status = 409;
    }
    throw error;
  }
  return getUser(result.lastInsertRowid);
}

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(userId, tokenHash(token), expiresAt);
  return { token, expiresAt };
}

export function findSessionUser(token) {
  if (!token) return null;
  const now = new Date().toISOString();
  const row = db.prepare(`
    SELECT
      u.id, u.username, u.display_name AS displayName, u.role,
      u.is_active AS isActive, u.created_at AS createdAt, u.updated_at AS updatedAt,
      s.expires_at AS expiresAt
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1
  `).get(tokenHash(token), now);
  return publicUser(row);
}

export function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function updateUserActive(id, isActive) {
  const result = db.prepare(`
    UPDATE users
    SET is_active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(isActive ? 1 : 0, id);
  if (!result.changes) return null;
  if (!isActive) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return getUser(id);
}

export function updatePassword(id, passwordHash) {
  const result = db.prepare(`
    UPDATE users
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(passwordHash, id);
  if (!result.changes) return null;
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return getUser(id);
}

export function activeAdminCount() {
  return db.prepare(`
    SELECT COUNT(*) AS count FROM users
    WHERE role = 'admin' AND is_active = 1
  `).get().count;
}
