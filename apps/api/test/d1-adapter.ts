import Sqlite from 'better-sqlite3';
import type { Db, Statement } from '../src/repo/db.js';

class BoundStatement implements Statement {
  private values: unknown[] = [];
  constructor(private readonly db: Sqlite.Database, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: r.changes } }; }
}
export class D1SqliteAdapter implements Db {
  constructor(readonly sqlite: Sqlite.Database) {}
  prepare(sql: string) { return new BoundStatement(this.sqlite, sql); }
  async batch(statements: Statement[]) { return Promise.all(statements.map(s=>s.run())); }
}
