export interface Db {
  prepare(sql: string): Statement;
  batch?(statements: Statement[]): Promise<unknown[]>;
}
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
}
export async function all<T>(db: Db, sql: string, ...values: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...values).all<T>()).results;
}
export async function first<T>(db: Db, sql: string, ...values: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...values).first<T>();
}
export async function run(db: Db, sql: string, ...values: unknown[]) {
  return db.prepare(sql).bind(...values).run();
}
export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');
