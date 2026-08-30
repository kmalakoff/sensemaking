import posix from 'node:path/posix';
import type { FileStat } from '../scan/index.ts';
import type { Connection } from '../store/types.ts';
import { maskRegions } from './fences.ts';
import type { ExtractedDoc, Feature, ReconcileDelta } from './types.ts';

// links(src, target, target_base, dst, embed): target as written, target_base its indexed baseKey, dst the resolved path or NULL (a queryable dead link).
// embed distinguishes `![[x]]`/`![](x.md)` from `[[x]]`/`[](x.md)` -- Obsidian's grain: a target both linked and embedded in one note is two rows.

// Alias stripped after |; a leading # keeps the anchor as the target (self-link needs a
// heading name), else the anchor splits off. Null = not a link.
function parseWikilinkInner(inner: string): string | null {
  const beforeAlias = inner.split('|')[0].trim();
  if (beforeAlias.startsWith('#')) return beforeAlias.length > 1 ? beforeAlias : null;
  const target = beforeAlias.split('#')[0].trim();
  return target || null;
}

// A frontmatter value counts only when it is exactly a wikilink ("[[X]]") -- mid-string and
// ![[...]] forms don't count there, per Obsidian's rule (probe-verified).
function extract(_raw: string, rawBody: string, _search?: { title: string; summary: string }, data?: Record<string, unknown>): Array<{ target: string; embed: boolean }> {
  const body = /\[\[|\]\(/.test(rawBody) ? maskRegions(rawBody) : rawBody;
  const seen = new Set<string>();
  const results: Array<{ target: string; embed: boolean }> = [];
  const add = (target: string, embed: boolean) => {
    const key = `${target}\0${embed ? '1' : '0'}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ target, embed });
  };
  // To the first ]], as Obsidian parses it, so a heading or alias holding a lone ] still
  // matches; anchor and alias split off in parseWikilinkInner.
  for (const m of body.matchAll(/\[\[(.*?)\]\]/g)) {
    const target = parseWikilinkInner(m[1]);
    if (target) add(target, body[(m.index ?? 0) - 1] === '!');
  }
  // Any internal destination, not only .md-suffixed: \](Zektor) resolves like [[Zektor]] and
  // \](#anchor) is a self-edge. External URLs and titled links (dest stops at whitespace) skip.
  for (const m of body.matchAll(/(!)?\[[^\]]*\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^)]*"|'[^)]*'))?\)/g)) {
    const dest = m[2].trim();
    // External: a URI scheme prefix (mailto:, tel:, data:, https:...), protocol-relative
    // //host, a www. shorthand, or a scheme anywhere (the malformed double-paren case).
    if (!dest || dest.includes('://')) continue;
    if (/^([a-z][a-z0-9+.-]*:|\/\/|www\.)/i.test(dest)) continue;
    const target = dest.startsWith('#') ? dest : dest.split('#')[0];
    if (target) add(target, m[1] === '!');
  }
  for (const value of Object.values(data ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string') continue;
      const m = /^\[\[(.*)\]\]$/.exec(item.trim());
      if (!m) continue;
      const target = parseWikilinkInner(m[1]);
      if (target) add(target, false);
    }
  }
  return results;
}

function cleanTarget(target: string): string {
  return target.replace(/\\/g, '/').replace(/^\.\//, '');
}

function baseKey(path: string): string {
  return posix.basename(path).replace(/\.md$/i, '').toLowerCase();
}

// Obsidian-style: exact relative path (with/without .md), path relative to the linking note's
// directory, then basename match (shortest path wins ties, verified against a cold-loaded vault).
function resolveTarget(src: string, target: string, pathSet: Set<string>, byBase: Map<string, string[]>): string | null {
  // [[#Heading]]: a same-note anchor, always the note itself -- never depends on other files.
  if (target.startsWith('#')) return src;
  const clean = cleanTarget(target);
  const fromSrc = posix.normalize(posix.join(posix.dirname(src), clean));
  for (const candidate of [clean, `${clean}.md`, fromSrc, `${fromSrc}.md`]) {
    if (pathSet.has(candidate)) return candidate;
  }
  const candidates = byBase.get(baseKey(clean));
  if (!candidates) return null;
  // The linking note itself wins a basename collision (Obsidian resolves to self before the
  // shortest-path rule -- cold-load verified on the hub corpus).
  return candidates.includes(src) ? src : candidates[0];
}

// Shortest path wins a basename collision; equal lengths fall back to lexicographic, our own
// deterministic tiebreak for a case Obsidian itself leaves registration-order-dependent.
function buildByBase(files: FileStat[]): Map<string, string[]> {
  const byBase = new Map<string, string[]>();
  const paths = files.map((f) => f.relPath).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  for (const path of paths) {
    const key = baseKey(path);
    const list = byBase.get(key);
    if (list) list.push(path);
    else byBase.set(key, [path]);
  }
  return byBase;
}

interface LinkRow {
  src: string;
  target: string;
  dst: string | null;
  embed: number;
}

// resolveTarget applied to `rows`, returning only the rows whose dst changed, so the caller
// can write them in one runBatch call.
function resolveRows(rows: LinkRow[], pathSet: Set<string>, byBase: Map<string, string[]>): LinkRow[] {
  const changed: LinkRow[] = [];
  for (const row of rows) {
    const dst = resolveTarget(row.src, row.target, pathSet, byBase);
    if (dst !== row.dst) changed.push({ ...row, dst });
  }
  return changed;
}

async function writeResolved(db: Connection, rows: LinkRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.runBatch(
    'UPDATE links SET dst = ? WHERE src = ? AND target = ?',
    rows.map((r) => [r.dst, r.src, r.target])
  );
}

// A new or deleted file can change any note's resolution, so re-resolve the whole table.
// Fallback for cold builds and large deltas -- see afterReconcile's threshold.
async function resolveAll(db: Connection, files: FileStat[]): Promise<boolean> {
  const pathSet = new Set(files.map((f) => f.relPath));
  const byBase = buildByBase(files);
  const stmt = await db.prepare('SELECT src, target, dst, embed FROM links');
  const rows = (await stmt.all()) as unknown as LinkRow[];
  const changed = resolveRows(rows, pathSet, byBase);
  await writeResolved(db, changed);
  return changed.length > 0;
}

// Chunked so a large-but-under-threshold delta never exceeds SQLite's bound-variable limit
// (SQLITE_MAX_VARIABLE_NUMBER, 32766); harmless headroom on DuckDB, which has no such cap.
async function selectIn(db: Connection, column: string, keys: string[]): Promise<LinkRow[]> {
  const rows: LinkRow[] = [];
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const stmt = await db.prepare(`SELECT src, target, dst, embed FROM links WHERE ${column} IN (${chunk.map(() => '?').join(', ')})`);
    rows.push(...((await stmt.all(...chunk)) as unknown as LinkRow[]));
  }
  return rows;
}

// Re-resolves only what this reconcile could have touched: re-stored sources, links whose
// target basename matches an added/vanished file, and links whose dst vanished -- all indexed.
async function resolveIncremental(db: Connection, delta: ReconcileDelta): Promise<boolean> {
  const pathSet = new Set(delta.files.map((f) => f.relPath));
  const byBase = buildByBase(delta.files);

  const changedBasenames = new Set<string>();
  for (const p of delta.added) changedBasenames.add(baseKey(p));
  for (const p of delta.vanished) changedBasenames.add(baseKey(p));

  // \0 can't appear in a path or target, so the key never collides; a space can.
  const candidates = new Map<string, LinkRow>();
  const collect = (rows: LinkRow[]) => {
    for (const row of rows) candidates.set(`${row.src}\0${row.target}\0${row.embed}`, row);
  };
  collect(await selectIn(db, 'src', delta.reparsed));
  collect(await selectIn(db, 'target_base', [...changedBasenames]));
  collect(await selectIn(db, 'dst', delta.vanished));

  const changed = resolveRows([...candidates.values()], pathSet, byBase);
  await writeResolved(db, changed);
  return changed.length > 0;
}

// One edge per (src, target); an embed row is excluded only when the same pair also exists as
// a link. Self-edges are dropped so PageRank mass is not self-recycled.
export const LINK_EDGES_SQL = `SELECT src, dst FROM links WHERE dst IS NOT NULL AND embed = 0 AND src != dst
    UNION ALL
    SELECT src, dst FROM links l WHERE dst IS NOT NULL AND embed = 1 AND src != dst
      AND NOT EXISTS (SELECT 1 FROM links l0 WHERE l0.src = l.src AND l0.target = l.target AND l0.embed = 0)`;

export function toEdges(rows: Array<{ src: string; dst: string }>): [string, string][] {
  return rows.map((r) => [r.src, r.dst]);
}

// Resolved edges, for rank (inside reconcile's afterReconcile pass).
export async function linkEdges(db: Connection): Promise<[string, string][]> {
  const stmt = await db.prepare(LINK_EDGES_SQL);
  return toEdges((await stmt.all()) as Array<{ src: string; dst: string }>);
}

// Records whether remove()/store() deleted any link row, since afterReconcile runs after both
// and dstChanged alone misses the reparsed-to-zero-links case. Keyed on delta so state dies with it.
const removedWithLinks = new WeakMap<ReconcileDelta, boolean>();

export const links: Feature = {
  name: 'links',
  async schema(db) {
    await db.exec('CREATE TABLE IF NOT EXISTS links (src TEXT, target TEXT, target_base TEXT, dst TEXT, embed INTEGER, PRIMARY KEY (src, target, embed))');
    await db.exec('CREATE INDEX IF NOT EXISTS links_dst ON links(dst)');
    await db.exec('CREATE INDEX IF NOT EXISTS links_target_base ON links(target_base)');
  },
  extract,
  // Reparsed docs are diffed in store() instead of wiped here: delete-and-reinsert resets dst
  // to NULL, making every touch-only reparse look like an edge change and recompute PageRank.
  async remove(db, paths, delta) {
    const vanishedSet = new Set(delta.vanished);
    const vanished = paths.filter((p) => vanishedSet.has(p));
    if (vanished.length === 0) return;
    const existingRows = await selectIn(db, 'src', vanished);
    await db.runBatch(
      'DELETE FROM links WHERE src = ?',
      vanished.map((p) => [p])
    );
    if (existingRows.length > 0) removedWithLinks.set(delta, true);
  },
  async store(db, docs: ExtractedDoc[], delta) {
    const byPath = new Map(docs.map((d) => [d.path, d.extracted as Array<{ target: string; embed: boolean }>]));
    const addedSet = new Set(delta.added);
    const reparsedExisting = docs.map((d) => d.path).filter((p) => !addedSet.has(p));

    // Stale rows (target/embed pairs missing from the new parse) are diffed in JS from one
    // bulk SELECT, so this pass costs one query plus one batched DELETE regardless of file count.
    const existingRows = await selectIn(db, 'src', reparsedExisting);
    const staleRows = existingRows.filter((row) => {
      const targets = byPath.get(row.src) ?? [];
      return !targets.some((t) => t.target === row.target && (t.embed ? 1 : 0) === row.embed);
    });
    if (staleRows.length > 0) {
      await db.runBatch(
        'DELETE FROM links WHERE src = ? AND target = ? AND embed = ?',
        staleRows.map((r) => [r.src, r.target, r.embed])
      );
      removedWithLinks.set(delta, true);
    }

    // Upsert preserves dst on surviving rows; only new rows start at NULL. A same-note anchor
    // gets no target_base, so SQL's `IN` excludes it from resolveIncremental's lookup.
    const upsertRows: unknown[][] = [];
    for (const [path, targets] of byPath) {
      for (const { target, embed } of targets) upsertRows.push([path, target, target.startsWith('#') ? null : baseKey(cleanTarget(target)), embed ? 1 : 0]);
    }
    if (upsertRows.length > 0) {
      await db.runBatch('INSERT INTO links (src, target, target_base, dst, embed) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(src, target, embed) DO UPDATE SET target_base = excluded.target_base', upsertRows);
    }
  },
  async afterReconcile(db, delta) {
    // Any deleted rows mean the edge set shrank -- whether the file vanished or was reparsed
    // down to fewer/no links.
    const removeHadLinks = removedWithLinks.get(delta) ?? false;

    const churn = delta.reparsed.length + delta.vanished.length;
    // Past this share of the tree, a full pass is the only one guaranteed to match
    // resolveTarget's ambiguity rules. A cold build clears the threshold on its own.
    const large = delta.files.length === 0 || churn > 0.2 * delta.files.length;

    const dstChanged = large ? await resolveAll(db, delta.files) : await resolveIncremental(db, delta);
    delta.linksChanged = dstChanged || removeHadLinks;
  },
};
