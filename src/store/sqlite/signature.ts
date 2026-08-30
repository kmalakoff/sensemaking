import type { Config } from '../../config/index.ts';
import { contentTokenize } from '../../config/index.ts';
import { listFiles, parseFile } from '../../scan/index.ts';
import { BEGIN_WRITE, withTransaction } from '../transaction.ts';
import type { Connection } from '../types.ts';
import { contentRow, INSERT_CONTENT_SQL } from './reconcile.ts';

// open()-lifecycle helpers for a config-signature change (see config.featureSignature's format:
// global features, embed provider, tokenize, then one segment per preset). Never called from
// reconcile() itself.

// Segment keys that moved between two feature signatures.
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

// Tokenize-only rebuild: only `content` is repopulated (the other tables are tokenizer-independent)
// and no feature extractors run. Returns per-file warnings, since mtimes stay untouched and reconcile would never reparse them.
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
  await withTransaction(
    conn,
    async () => {
      if (rows.length > 0) await conn.runBatch(INSERT_CONTENT_SQL, rows);
    },
    BEGIN_WRITE
  );
  return warnings;
}
