import { E } from './errors';

/** Opaque keyset cursor: base64url(JSON array of the sort key of the last row). */
export function encodeCursor(key: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, arity: number): string[] | null {
  if (!cursor) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === arity) return v.map(String);
  } catch {
    // fall through
  }
  throw E.validation('Bad cursor');
}

/** Rows were fetched with LIMIT limit+1: trims the extra row and builds nextCursor from the last kept row. */
export function pageOf<R, T>(rows: R[], limit: number, key: (r: R) => (string | number)[], map: (r: R) => T): { items: T[]; nextCursor: string | null } {
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  return { items: kept.map(map), nextCursor: more && last ? encodeCursor(key(last)) : null };
}

/** Escapes LIKE wildcards in user input. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
