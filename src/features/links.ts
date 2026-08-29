import posix from 'node:path/posix';
import type { FileStat } from '../scan/index.ts';
import type { Connection } from '../store/types.ts';
import { maskRegions } from './fences.ts';
import type { ExtractedDoc, Feature, ReconcileDelta } from './types.ts';

// links(src, target, target_base, dst, embed): target as written, target_base its baseKey
// (indexed, for the incremental resolve below), dst the resolved path or NULL (a
// queryable dead link), embed whether it's `![[x]]`/`![](x.md)` rather than `[[x]]`/`[](x.md)`
// -- Obsidian's grain: a target both linked and embedded in the same note is two rows.

// Wikilinks ([[target]], [[target#anchor|alias]], embeds), internal markdown links, and
// frontmatter values that are exactly a wikilink ("[[X]]"; mid-string and ![[...]] forms are
// not links there -- Obsidian's rule, probe-verified).
// One rule for [[inner]] text wherever it appears: alias stripped after |, a leading #
// keeps the anchor as the target (a same-note self-link needs a heading name), otherwise
// the anchor splits off. Null = not a link.
function parseWikilinkInner(inner: string): string | null {
  const beforeAlias = inner.split('|')[0].trim();
  if (beforeAlias.startsWith('#')) return beforeAlias.length > 1 ? beforeAlias : null;
  const target = beforeAlias.split('#')[0].trim();
  return target || null;
}

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
  // Any internal destination, not only .md-suffixed: Obsidian gives markdown links full
  // linkpath resolution, so \](Zektor) resolves like [[Zektor]] and \](#anchor) is a
  // self-edge. External URLs (a scheme anywhere survives the malformed double-paren case)
  // and titled links (dest stops at whitespace) are skipped.
  // A space in the destination is only valid ahead of a quoted title; a domain-shaped first
  // segment (www.example.com/...) is external even without a scheme.
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

// Obsidian-style: exact relative path (with/without .md), path relative to the linking
// note's directory, then basename match (shortest path wins on ties -- verified against a
// cold-loaded Obsidian vault on 6+ real collision pairs; byBase's lists are pre-sorted that way).
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

// resolveTarget applied to `rows`, returning just the rows whose dst actually changed -- the
// caller writes those in one runBatch call, keyed on (src, target) so a link/embed sibling
// pair sharing one resolution rewrites both.
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

// Re-resolve only what this reconcile could have touched: re-stored sources, links whose
// target basename matches an added/vanished file, and links whose dst just vanished. All
// three are indexed lookups, so this never reads the whole table.
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

// One edge per row, as 0.12's grain always had it -- two written targets resolving to one
// dst stay two edges (a weight the fusion evals were gated on). The only exclusion is an
// embed whose exact (src, target) also exists as a link: that second row is new with the
// embed grain and would double an edge that used to be one row. The NOT EXISTS probes the
// primary key and fires only for embed rows; both branches still scan the table.
// Self-edges (same-note anchors) are excluded here so PageRank mass is not self-recycled --
// Obsidian's own graph view hides self-loops too. The rows themselves stay in the table for
// backlinks/peek. Exported (not just linkEdges below) so commands/signals.ts's async caller,
// which only has the Store's prepare(), can run the identical statement itself.
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

// remove()/store() have already deleted rows by the time afterReconcile runs, so this records
// whether any reconcile pass deleted at least one link row -- whether a file vanished, or a
// reparse's stale rows shrank. dstChanged alone misses the reparsed-to-zero-links case (no
// surviving rows to re-resolve). Keyed on the delta object, so the state dies with the reconcile.
const removedWithLinks = new WeakMap<ReconcileDelta, boolean>();

export const links: Feature = {
  name: 'links',
  async schema(db) {
    await db.exec('CREATE TABLE IF NOT EXISTS links (src TEXT, target TEXT, target_base TEXT, dst TEXT, embed INTEGER, PRIMARY KEY (src, target, embed))');
    await db.exec('CREATE INDEX IF NOT EXISTS links_dst ON links(dst)');
    await db.exec('CREATE INDEX IF NOT EXISTS links_target_base ON links(target_base)');
  },
  extract,
  // Reparsed docs are diffed in store() below instead of wiped here: deleting and re-inserting
  // resets dst to NULL, which made every touch-only reparse read as an edge change and
  // recompute PageRank -- measured as most of the remaining update cost. Only genuinely
  // vanished files clear here.
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

    // Stale rows (existing target/embed pairs the new parse no longer contains) are real edge
    // removals; diffed in JS from one bulk SELECT rather than a per-file NOT IN statement, so
    // this whole pass costs one query plus one batched DELETE regardless of file count.
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

    // Upsert preserves dst on surviving rows, so an unchanged link resolves to the same value
    // and reports no change; only genuinely new rows start at NULL. A same-note anchor's dst is
    // always its own src, never another file's basename, so it gets no target_base -- SQL's
    // `IN` never matches NULL, keeping it out of resolveIncremental's target_base lookup.
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
