import type { Config } from '../../config/index.ts';
import { contentTokenize } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures } from '../../features/index.ts';
import type { ExtractedDoc, ReconcileDelta } from '../../features/types.ts';
import { progress } from '../../output/progress.ts';
import type { ParsedDoc } from '../../scan/index.ts';
import { listFiles, parseFile, RESERVED_COLUMNS } from '../../scan/index.ts';
import { reparseFiles } from '../../scan/reparse.ts';
import { segmentField } from '../../text/segment.ts';
import { getColumns, getMeta, quoteIdent, setMeta } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Connection } from '../types.ts';

// Feature-owned columns (`_rank`) must stay out of the upsert: a reparse would null the last
// computed value on every touch, not just the reconciles that recompute it.
const CORE_FRONTMATTER_COLUMNS = new Set(['path', '_mtime', '_ctime', '_size', '_parse_error']);

// SQLite's compile-time SQLITE_MAX_COLUMN, default 2000 (https://www.sqlite.org/limits.html).
const MAX_FRONTMATTER_COLUMNS = 2000;

// Shared by reconcile() and the tokenize-only rebuild in open(), so both prepare the same
// literal instead of two copies drifting apart.
const INSERT_CONTENT_SQL = `INSERT INTO content (rowid, title, summary, text, "path", title_seg, summary_seg, text_seg) VALUES ((SELECT rowid FROM frontmatter WHERE "path" = ?), ?, ?, ?, ?, ?, ?, ?)`;

// A single content row's param tuple, matching INSERT_CONTENT_SQL's placeholder order.
// Assumes the frontmatter row for doc.relPath already exists (rowid subquery).
function contentRow(doc: ParsedDoc, segmenting: boolean): unknown[] {
  return [doc.relPath, doc.search.title, doc.search.summary, doc.search.text, doc.relPath, segmenting ? segmentField(doc.search.title) : '', segmenting ? segmentField(doc.search.summary) : '', segmenting ? segmentField(doc.search.text) : ''];
}

export async function reconcile(conn: Connection, cfg: Config, baseDir: string): Promise<{ parsed: number; warnings: string[] }> {
  const files = listFiles(cfg, baseDir);
  const currentSet = new Set(files.map((f) => f.relPath));

  const existingStmt = await conn.prepare('SELECT "path", "_mtime", "_size" FROM frontmatter');
  const existingRows = (await existingStmt.all()) as Array<{ path: string; _mtime: number; _size: number }>;
  const existing = new Map(existingRows.map((r) => [r.path, r]));
  const vanished = existingRows.filter((r) => !currentSet.has(r.path)).map((r) => r.path);

  const toReparse = files.filter((f) => {
    const row = existing.get(f.relPath);
    return !row || row._mtime !== f.mtimeMs || row._size !== f.size;
  });

  if (vanished.length === 0 && toReparse.length === 0) return { parsed: 0, warnings: [] };

  const features = activeFeatures(cfg);
  const seenColumns = await getColumns(conn);

  // Bulk reparses (a sync, a cold build) are the long silences a query can hit; short
  // reconciles stay silent (progress() has a threshold).
  const report = progress('reparsing files', toReparse.length);
  const { docs: parsedDocs, warnings, newColumns } = await reparseFiles(toReparse, features, cfg, seenColumns, report.tick);
  report.finish();
  for (const col of newColumns) seenColumns.add(col);

  const allColumns = [...seenColumns];
  // Fence before ALTERing: SQLite's own failure past this point is a raw
  // "too many columns on sqlite_altertab_frontmatter" with no indication of the boundary or the levers.
  if (allColumns.length > MAX_FRONTMATTER_COLUMNS) {
    throw new SenseError(
      'COLUMN_LIMIT',
      `frontmatter would need ${allColumns.length} columns, crossing SQLite's compile-time SQLITE_MAX_COLUMN limit (default ${MAX_FRONTMATTER_COLUMNS}; see https://www.sqlite.org/limits.html). Narrow the presets' include globs so fewer/other files are indexed, or fix whatever is generating unbounded frontmatter keys.`
    );
  }
  // Columns the frontmatter upsert actually writes: core + parsed frontmatter keys, never a
  // feature-owned reserved column (see CORE_FRONTMATTER_COLUMNS above).
  const writableColumns = allColumns.filter((c) => CORE_FRONTMATTER_COLUMNS.has(c) || !RESERVED_COLUMNS.has(c));
  // ON CONFLICT UPDATE (not OR REPLACE) keeps the row's rowid stable across reparses --
  // content rows are coupled to that rowid below.
  const insertSql = `INSERT INTO frontmatter (${writableColumns.map(quoteIdent).join(', ')}) VALUES (${writableColumns.map(() => '?').join(', ')}) ON CONFLICT("path") DO UPDATE SET ${writableColumns
    .filter((c) => c !== 'path')
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
    .join(', ')}`;

  const added = toReparse.filter((f) => !existing.has(f.relPath)).map((f) => f.relPath);
  const delta: ReconcileDelta = { files, reparsed: parsedDocs.map((d) => d.relPath), added, vanished };
  const addedSet = new Set(added);
  const reparsedExisting = parsedDocs.map((d) => d.relPath).filter((p) => !addedSet.has(p));

  const txStart = Date.now();
  await withTransaction(conn, async () => {
    for (const col of newColumns) await conn.exec(`ALTER TABLE frontmatter ADD COLUMN ${quoteIdent(col)}`);

    // content's rowid lookup depends on the frontmatter row it's coupled to, so every content
    // delete/insert below must run after that row exists (vanished paths still have their
    // frontmatter row at this point) and before it is removed (vanished frontmatter delete
    // comes last).
    if (vanished.length > 0) {
      await conn.runBatch(
        'DELETE FROM content WHERE rowid = (SELECT rowid FROM frontmatter WHERE "path" = ?)',
        vanished.map((p) => [p])
      );
    }
    if (reparsedExisting.length > 0) {
      // FTS5 has no upsert, so delete-before-insert into `content`, coupled to the frontmatter
      // rowid (indexed via its PRIMARY KEY) rather than the UNINDEXED `path` column, which a
      // per-row DELETE would otherwise scan the whole table to find.
      await conn.runBatch(
        'DELETE FROM content WHERE rowid = (SELECT rowid FROM frontmatter WHERE "path" = ?)',
        reparsedExisting.map((p) => [p])
      );
    }

    if (parsedDocs.length > 0) {
      const rows = parsedDocs.map((doc) =>
        writableColumns.map((col) => {
          if (col === 'path') return doc.relPath;
          if (col === '_mtime') return doc.mtimeMs;
          if (col === '_ctime') return doc.ctimeMs;
          if (col === '_size') return doc.size;
          // Written per parse, unlike _rank, which a feature pass owns and the upsert skips.
          if (col === '_parse_error') return doc.parseError;
          return doc.data[col] ?? null;
        })
      );
      await conn.runBatch(insertSql, rows);

      // A non-default tokenizer means the tree has chosen its own scheme; a phrase query over
      // grapheme runs would be nonsense against trigram, so the sidecars stay empty.
      const segmenting = contentTokenize(cfg) === undefined;
      await conn.runBatch(
        INSERT_CONTENT_SQL,
        parsedDocs.map((doc) => contentRow(doc, segmenting))
      );
    }

    if (vanished.length > 0)
      await conn.runBatch(
        'DELETE FROM frontmatter WHERE "path" = ?',
        vanished.map((p) => [p])
      );

    // A preset edit forces a full rebuild, so an unchanged doc's coverage is already correct;
    // new docs have nothing to clear, which keeps cold builds linear.
    const presetTouched = [...vanished, ...reparsedExisting];
    if (presetTouched.length > 0)
      await conn.runBatch(
        'DELETE FROM preset_files WHERE "path" = ?',
        presetTouched.map((p) => [p])
      );
    const presetRows: unknown[][] = [];
    for (const doc of parsedDocs) for (const presetName of doc.presets) presetRows.push([doc.relPath, presetName]);
    if (presetRows.length > 0) await conn.runBatch('INSERT INTO preset_files ("path", preset) VALUES (?, ?)', presetRows);

    const removedPaths = [...vanished, ...reparsedExisting];
    if (removedPaths.length > 0) for (const feature of features) await feature.remove?.(conn, removedPaths, delta);
    for (const feature of features) {
      const docsForFeature: ExtractedDoc[] = parsedDocs.map((doc) => ({ path: doc.relPath, extracted: doc.extracted[feature.name] }));
      await feature.store?.(conn, docsForFeature, delta);
    }
    for (const feature of features) await feature.afterReconcile?.(conn, delta);
  });

  // Reconcile's own write-transaction duration, for open()'s derived busy_timeout (F):
  // keep the observed max so a big watcher reconcile's lock hold is what the next open bounds its wait against.
  const durationMs = Date.now() - txStart;
  const prevRaw = await getMeta(conn, 'reconcile_max_ms');
  // -1, not 0, so a genuinely 0ms first reconcile (sub-millisecond, common on a tiny tree)
  // still gets recorded instead of losing to the "nothing recorded yet" default.
  const prevMax = prevRaw === null ? -1 : Number(prevRaw);
  if (durationMs > prevMax) await setMeta(conn, 'reconcile_max_ms', String(durationMs));

  return { parsed: parsedDocs.length, warnings };
}

// Segment keys that moved between two feature signatures (see config.featureSignature's
// format: global features, embed provider, tokenize, then one segment per preset).
export function changedSignatureKeys(before: string, after: string): Set<string> {
  const keyOf = (part: string) => (part.startsWith('preset:') ? part.split(':').slice(0, 2).join(':') : part.split(':')[0]);
  const parse = (sig: string) => new Map(sig.split('|').map((part) => [keyOf(part), part]));
  const a = parse(before);
  const b = parse(after);
  const changed = new Set<string>();
  for (const [key, val] of b) if (a.get(key) !== val) changed.add(key);
  for (const key of a.keys()) if (!b.has(key)) changed.add(key);
  return changed;
}

// Whether the embed segment only gained its resolved weight identity: same provider and
// model, no identity recorded before, one now -- adopted into meta without a rebuild.
export function embedIdentityAdopted(before: string, after: string): boolean {
  const embedPart = (sig: string) => sig.split('|').find((p) => p.startsWith('embed:'));
  const b = embedPart(before);
  const a = embedPart(after);
  if (b === undefined || a === undefined) return false;
  const at = a.indexOf('@');
  return b.indexOf('@') === -1 && at !== -1 && a.slice(0, at) === b;
}

// Names what moved, for the rebuild notice.
export function signatureDiff(before: string, after: string): string {
  const changed = changedSignatureKeys(before, after);
  const label = (key: string) => (key === 'embed' ? 'embed settings' : key === 'tokenize' ? 'content tokenizer' : key.startsWith('preset:') ? `preset "${key.slice(7)}"` : 'features');
  return changed.size === 0 ? 'features' : [...changed].map(label).join(', ');
}

// The tokenize-only rebuild in open(): content is dropped and repopulated from files already
// listed in frontmatter, which itself is untouched. Frontmatter, links, sections, and
// embeddings are file-derived and tokenizer-independent, so they survive. No feature extractors
// run here -- doc.search (title/summary/text) is all content population needs. Returns
// parseFile's per-file warnings (e.g. a bad date) so open() can surface them -- mtimes are
// untouched, so reconcile() never reparses these files and would otherwise never emit them again.
export async function rebuildContentTable(conn: Connection, cfg: Config, baseDir: string): Promise<string[]> {
  const stmt = await conn.prepare('SELECT "path" FROM frontmatter');
  const known = new Set(((await stmt.all()) as Array<{ path: string }>).map((r) => r.path));
  const files = listFiles(cfg, baseDir).filter((f) => known.has(f.relPath));
  const segmenting = contentTokenize(cfg) === undefined;
  const warnings: string[] = [];
  const rows: unknown[][] = [];
  for (const file of files) {
    const { doc, warnings: fileWarnings } = parseFile(file);
    warnings.push(...fileWarnings);
    rows.push(contentRow(doc, segmenting));
  }
  await withTransaction(conn, async () => {
    if (rows.length > 0) await conn.runBatch(INSERT_CONTENT_SQL, rows);
  });
  return warnings;
}
