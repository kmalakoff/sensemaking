import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Config } from '../config/index.ts';
import { contentTokenize } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { activeFeatures } from '../features/index.ts';
import type { ReconcileDelta } from '../features/types.ts';
import { progress } from '../progress.ts';
import type { ParsedDoc } from '../scan.ts';
import { listFiles, parseFile, RESERVED_COLUMNS } from '../scan.ts';
import { segmentField } from '../segment.ts';
import { getColumns, getMeta, quoteIdent, setMeta } from './shared.ts';

// Feature-owned columns (`_rank`) must stay out of the upsert: a reparse would null the last
// computed value on every touch, not just the reconciles that recompute it.
const CORE_FRONTMATTER_COLUMNS = new Set(['path', '_mtime', '_ctime', '_size', '_parse_error']);

// SQLite's compile-time SQLITE_MAX_COLUMN, default 2000 (https://www.sqlite.org/limits.html).
const MAX_FRONTMATTER_COLUMNS = 2000;

// Shared by reconcile() and the tokenize-only rebuild in open(), so both prepare the same
// literal instead of two copies drifting apart.
const INSERT_CONTENT_SQL = `INSERT INTO content (rowid, title, summary, text, "path", title_seg, summary_seg, text_seg) VALUES ((SELECT rowid FROM frontmatter WHERE "path" = ?), ?, ?, ?, ?, ?, ?, ?)`;

// Shared by reconcile() and the tokenize-only rebuild in open(), so content population is
// defined once. Assumes the frontmatter row for doc.relPath already exists (rowid lookup).
function insertContentRow(insertBody: StatementSync, doc: ParsedDoc, segmenting: boolean): void {
  insertBody.run(doc.relPath, doc.search.title, doc.search.summary, doc.search.text, doc.relPath, segmenting ? segmentField(doc.search.title) : '', segmenting ? segmentField(doc.search.summary) : '', segmenting ? segmentField(doc.search.text) : '');
}

export function reconcile(db: DatabaseSync, cfg: Config, baseDir: string): { parsed: number; warnings: string[] } {
  const files = listFiles(cfg, baseDir);
  const currentSet = new Set(files.map((f) => f.relPath));

  const existingRows = db.prepare(`SELECT "path", "_mtime", "_size" FROM frontmatter`).all() as Array<{
    path: string;
    _mtime: number;
    _size: number;
  }>;
  const existing = new Map(existingRows.map((r) => [r.path, r]));
  const vanished = existingRows.filter((r) => !currentSet.has(r.path)).map((r) => r.path);

  const toReparse = files.filter((f) => {
    const row = existing.get(f.relPath);
    return !row || row._mtime !== f.mtimeMs || row._size !== f.size;
  });

  if (vanished.length === 0 && toReparse.length === 0) return { parsed: 0, warnings: [] };

  const features = activeFeatures(cfg);
  const seenColumns = getColumns(db);
  const newColumns: string[] = [];
  const parsedDocs: ParsedDoc[] = [];
  const warnings: string[] = [];

  // Bulk reparses (a sync, a cold build) are the long silences a query can hit; short
  // reconciles stay silent (progress() has a threshold).
  const report = progress('reparsing files', toReparse.length);
  let parsedCount = 0;
  for (const file of toReparse) {
    // A doc only gets extract/store from features that apply to it (currently: embed, via
    // FileStat.embed -- true iff the config names an embedding model).
    const fileFeatures = features.filter((feature) => !feature.enabledForFile || feature.enabledForFile(cfg, file));
    const { doc, warnings: fileWarnings } = parseFile(file, fileFeatures);
    report.tick(++parsedCount);
    warnings.push(...fileWarnings);
    for (const key of Object.keys(doc.data)) {
      if (!seenColumns.has(key)) {
        seenColumns.add(key);
        newColumns.push(key);
      }
    }
    parsedDocs.push(doc);
  }
  report.finish();

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

  const txStart = Date.now();
  db.exec('BEGIN');
  try {
    for (const col of newColumns) db.exec(`ALTER TABLE frontmatter ADD COLUMN ${quoteIdent(col)}`);
    // FTS5 has no upsert, so delete-before-insert into `content`; coupled to the
    // frontmatter rowid (indexed via its PRIMARY KEY) instead of the UNINDEXED `path`
    // column, which a per-row DELETE would otherwise scan the whole table to find.
    const delBody = db.prepare(`DELETE FROM content WHERE rowid = (SELECT rowid FROM frontmatter WHERE "path" = ?)`);
    const delPresetFiles = db.prepare(`DELETE FROM preset_files WHERE "path" = ?`);
    const insertPresetFile = db.prepare(`INSERT INTO preset_files ("path", preset) VALUES (?, ?)`);
    if (vanished.length > 0) {
      const del = db.prepare(`DELETE FROM frontmatter WHERE "path" = ?`);
      for (const path of vanished) {
        // content delete must run first: it looks up the frontmatter rowid by path, which
        // the frontmatter delete below would otherwise have already removed.
        delBody.run(path);
        del.run(path);
        delPresetFiles.run(path);
        for (const feature of features) feature.remove?.(db, path, delta);
      }
    }
    if (parsedDocs.length > 0) {
      const insert = db.prepare(insertSql);
      const insertBody = db.prepare(INSERT_CONTENT_SQL);
      // A non-default tokenizer means the tree has chosen its own scheme; a phrase query over
      // grapheme runs would be nonsense against trigram, so the sidecars stay empty.
      const segmenting = contentTokenize(cfg) === undefined;
      for (const doc of parsedDocs) {
        const values = writableColumns.map((col) => {
          if (col === 'path') return doc.relPath;
          if (col === '_mtime') return doc.mtimeMs;
          if (col === '_ctime') return doc.ctimeMs;
          if (col === '_size') return doc.size;
          // Written per parse, unlike _rank, which a feature pass owns and the upsert skips.
          if (col === '_parse_error') return doc.parseError;
          return doc.data[col] ?? null;
        });
        // Frontmatter upsert first: content's rowid lookup below depends on this row existing.
        insert.run(...values);
        // Only for docs that have rows: an unconditional delete made cold crawls quadratic.
        if (existing.has(doc.relPath)) {
          delBody.run(doc.relPath);
          for (const feature of features) feature.remove?.(db, doc.relPath, delta);
        }
        insertContentRow(insertBody, doc, segmenting);
        // A preset edit forces a full rebuild, so an unchanged doc's coverage is already
        // correct; new docs have nothing to clear, which keeps cold builds linear.
        if (existing.has(doc.relPath)) delPresetFiles.run(doc.relPath);
        for (const presetName of doc.presets) insertPresetFile.run(doc.relPath, presetName);
        for (const feature of features) feature.store?.(db, doc.relPath, doc.extracted[feature.name], delta);
      }
    }
    for (const feature of features) feature.afterReconcile?.(db, delta);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Reconcile's own write-transaction duration, for open()'s derived busy_timeout (F):
  // keep the observed max so a big watcher reconcile's lock hold is what the next open bounds its wait against.
  const durationMs = Date.now() - txStart;
  const prevRaw = getMeta(db, 'reconcile_max_ms');
  // -1, not 0, so a genuinely 0ms first reconcile (sub-millisecond, common on a tiny tree)
  // still gets recorded instead of losing to the "nothing recorded yet" default.
  const prevMax = prevRaw === null ? -1 : Number(prevRaw);
  if (durationMs > prevMax) setMeta(db, 'reconcile_max_ms', String(durationMs));

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
export function rebuildContentTable(db: DatabaseSync, cfg: Config, baseDir: string): string[] {
  const known = new Set((db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path));
  const files = listFiles(cfg, baseDir).filter((f) => known.has(f.relPath));
  const segmenting = contentTokenize(cfg) === undefined;
  const insertBody = db.prepare(INSERT_CONTENT_SQL);
  const warnings: string[] = [];
  db.exec('BEGIN');
  try {
    for (const file of files) {
      const { doc, warnings: fileWarnings } = parseFile(file);
      warnings.push(...fileWarnings);
      insertContentRow(insertBody, doc, segmenting);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return warnings;
}
