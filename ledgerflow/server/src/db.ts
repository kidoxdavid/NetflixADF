import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.ts';

export type DB = DatabaseSync;
export type Row = Record<string, any>;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

export function migrate(db: DB): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  const done = new Set((db.prepare('SELECT id FROM schema_migrations').all() as Row[]).map((r) => r.id as number));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
      db.exec('COMMIT');
      applied.push(m.id);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return applied;
}

const depth = new WeakMap<DB, number>();
/** Run fn in a transaction (BEGIN IMMEDIATE); nested calls use savepoints. Rolls back on throw. */
export function tx<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  const sp = `sp_${d}`;
  db.exec(d === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth.set(db, d + 1);
  try {
    const r = fn();
    depth.set(db, d);
    db.exec(d === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth.set(db, d);
    try { db.exec(d === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch { /* ignore */ }
    throw e;
  }
}

export const all = <T = Row>(db: DB, sql: string, ...p: SQLInputValue[]): T[] => db.prepare(sql).all(...p) as T[];
export const get = <T = Row>(db: DB, sql: string, ...p: SQLInputValue[]): T | undefined => db.prepare(sql).get(...p) as T | undefined;
export const run = (db: DB, sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);
export const insert = (db: DB, sql: string, ...p: SQLInputValue[]): number => Number(db.prepare(sql).run(...p).lastInsertRowid);

/** Build a safe INSERT/UPDATE from an object (columns come from code, never from user keys). */
export function insertRow(db: DB, table: string, data: Row): number {
  const keys = Object.keys(data);
  return insert(db, `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => data[k] ?? null));
}
export function updateRow(db: DB, table: string, id: number, data: Row) {
  const keys = Object.keys(data); if (!keys.length) return;
  run(db, `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => data[k] ?? null), id);
}
