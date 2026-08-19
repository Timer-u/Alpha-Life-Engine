export interface FakeD1Rule {
  match: (sql: string, args: unknown[]) => boolean;
  rows: unknown[] | ((sql: string, args: unknown[]) => unknown[]);
  changes?: number;
}

function fullMeta(changes: number): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes,
  };
}

export class FakeStatement {
  constructor(
    private readonly db: FakeD1,
    readonly sql: string,
    readonly args: unknown[]
  ) {}

  bind(...values: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const rows = this.db.resolveRows(this.sql, this.args);
    return (rows[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return {
      results: this.db.resolveRows(this.sql, this.args) as T[],
      success: true,
      meta: fullMeta(1),
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const changes = this.db.resolveRule(this.sql, this.args)?.changes ?? 1;
    return { results: [], success: true, meta: fullMeta(changes) };
  }
}

export class FakeD1 {
  constructor(private readonly rules: FakeD1Rule[]) {}

  resolveRule(sql: string, args: unknown[]): FakeD1Rule | undefined {
    return this.rules.find(rule => rule.match(sql, args));
  }

  resolveRows(sql: string, args: unknown[]): unknown[] {
    const rule = this.resolveRule(sql, args);
    if (!rule) return [];
    return typeof rule.rows === 'function' ? rule.rows(sql, args) : rule.rows;
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql, []);
  }

  statements: string[] = [];
  statementArgs: unknown[][] = [];
  statementChanges: number[] = [];

  async batch(stmts: FakeStatement[]): Promise<D1Result[]> {
    const out: D1Result[] = [];
    for (const stmt of stmts) {
      this.statements.push(stmt.sql);
      this.statementArgs.push(stmt.args);
      const all = await stmt.all();
      const changes = this.resolveRule(stmt.sql, stmt.args)?.changes ?? 1;
      this.statementChanges.push(changes);
      out.push({ ...all, meta: fullMeta(changes) });
    }
    return out;
  }
}

export function asD1(db: FakeD1): D1Database {
  return db as unknown as D1Database;
}
