import { maskRegions } from './fences.ts';
import type { Feature } from './types.ts';

// tags(path, tag): Obsidian's file.tags grain -- frontmatter list/string tags plus inline
// #tags, deduplicated, source not distinguished. Nested tags store full (book/scifi); `tag = 'book' OR tag LIKE 'book/%'` matches the parent too.

// Obsidian treats [[#Heading]] as a same-note link, not a tag.
const WIKILINK_RE = /\[\[.*?\]\]/g; // to the first ]], so a heading holding a lone ] still masks
// Obsidian doesn't read tags inside HTML markup.
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g; // tag-shaped only: a comparison's `< 5` must not open a span
// Anchors on start-of-line or a preceding whitespace/(/[ so `a#b` and URL fragments don't count.
const INLINE_TAG_RE = /(?:^|[\s([])#([\p{L}\p{N}_/-]+)/gu;
// A markdown link destination `](...)` -- `[text](#anchor)` is a same-page link, not a tag.
const LINK_DEST_RE = /\]\((?:[^()]|\([^()]*\))*\)/g; // one paren-nesting level, as CommonMark destinations allow: (https://x/a_(b)#frag)

// Strips a leading # (frontmatter entries may carry one) and a trailing /; rejects an
// all-digit result -- a tag needs at least one non-digit character.
function normalizeTag(raw: string): string | null {
  const stripped = raw.replace(/^#/, '').replace(/\/+$/, '');
  if (!stripped || /^\d+$/.test(stripped)) return null;
  return stripped;
}

// data.tags: a YAML list (Obsidian also accepts a bare string). Null members and non-string
// members are skipped rather than throwing -- `tags:\n  -` parses to [null].
function frontmatterTags(data?: Record<string, unknown>): string[] {
  const raw = data?.tags;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const found: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const tag = normalizeTag(item);
    if (tag) found.push(tag);
  }
  return found;
}

// #tag tokens outside the regions maskRegions() masks (fences, code spans, wikilinks, HTML,
// comments, link destinations); this loop only does per-line tag extraction.
function inlineTags(body: string): string[] {
  const found: string[] = [];
  for (const line of maskRegions(body).split('\n')) {
    if (!line.includes('#')) continue; // most lines; skip the regex work
    let cleaned = line;
    if (cleaned.includes('[[')) cleaned = cleaned.replace(WIKILINK_RE, (m) => ' '.repeat(m.length));
    if (cleaned.includes('](')) cleaned = cleaned.replace(LINK_DEST_RE, (m) => ' '.repeat(m.length));
    if (cleaned.includes('<')) cleaned = cleaned.replace(HTML_TAG_RE, (m) => ' '.repeat(m.length));
    for (const m of cleaned.matchAll(INLINE_TAG_RE)) {
      const tag = normalizeTag(m[1]);
      if (tag) found.push(tag);
    }
  }
  return found;
}

function extract(_raw: string, body: string, _search?: { title: string; summary: string }, data?: Record<string, unknown>): string[] {
  return [...new Set([...frontmatterTags(data), ...inlineTags(body)])].sort();
}

export const tags: Feature = {
  name: 'tags',
  async schema(db) {
    await db.exec('CREATE TABLE IF NOT EXISTS tags ("path" TEXT, tag TEXT, PRIMARY KEY ("path", tag))');
    await db.exec('CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag)');
  },
  extract,
  // Blanket clear-then-reinsert (store() always writes the full found list back), so remove()
  // covers vanished and reparsed files without per-file NOT IN diffing, which cannot be one statement shared across files.
  async remove(db, paths) {
    if (paths.length === 0) return;
    await db.runBatch(
      'DELETE FROM tags WHERE "path" = ?',
      paths.map((p) => [p])
    );
  },
  async store(db, docs) {
    const rows: unknown[][] = [];
    for (const { path, extracted } of docs) for (const tag of extracted as string[]) rows.push([path, tag]);
    if (rows.length === 0) return;
    await db.runBatch('INSERT OR IGNORE INTO tags ("path", tag) VALUES (?, ?)', rows);
  },
};
