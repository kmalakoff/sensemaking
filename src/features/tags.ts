import { commentTracker, fenceTracker, maskCodeSpans } from '../fences.ts';
import type { Feature } from './types.ts';

// tags(path, tag): Obsidian's file.tags grain -- frontmatter list/string tags plus inline
// #tags from the prose, deduplicated, source not distinguished. Nested tags store full
// (book/scifi); `tag = 'book' OR tag LIKE 'book/%'` is how a caller matches the parent too.

// Obsidian treats [[#Heading]] as a same-note link, not a tag.
const WIKILINK_RE = /\[\[.*?\]\]/g; // to the first ]], so a heading holding a lone ] still masks
// Obsidian doesn't read tags inside HTML markup.
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g; // tag-shaped only: a comparison's `< 5` must not open a span
// Anchors on start-of-line or a preceding whitespace/(/[ so `a#b` and URL fragments don't count.
const INLINE_TAG_RE = /(?:^|[\s([])#([\p{L}\p{N}_/-]+)/gu;
// A markdown link destination `](...)` -- `[text](#anchor)` is a same-page link, not a tag.
const LINK_DEST_RE = /\]\((?:[^()]|\([^()]*\))*\)/g; // one paren-nesting level, as CommonMark destinations allow: (https://x/a_(b)#frag)

// CommonMark's HTML-block type-6 list (fixed by the spec, not a drifting enumeration): a line
// starting with an open or close tag of one of these, at column 0, opens a block that swallows
// following lines -- including any #tag in them -- until a blank line closes it.
const HTML_BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'base',
  'basefont',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'link',
  'main',
  'menu',
  'menuitem',
  'nav',
  'noframes',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'search',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'track',
  'ul',
]);
// Type-1 blocks (script/pre/style/textarea): closes on the line holding the matching end tag,
// not on a blank line, and that line is the last one skipped.
const HTML_PRE_TAGS = new Set(['script', 'pre', 'style', 'textarea']);
// An opening or closing tag at column 0, tag name captured for the lookups above.
const HTML_BLOCK_OPEN_RE = /^<\/?([a-zA-Z][a-zA-Z0-9]*)(?:[ \t]|\/?>|$)/;

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

// #tag tokens outside fenced code blocks, inline code spans, wikilinks, HTML tags, HTML blocks,
// <!-- --> comments, and link destinations.
function inlineTags(body: string): string[] {
  const found: string[] = [];
  const fence = fenceTracker();
  const comment = commentTracker();
  let inHtmlBlock = false;
  let htmlBlockClose: RegExp | null = null; // set while inside a type-1 (script/pre/style/textarea) block
  for (const line of body.split('\n')) {
    if (inHtmlBlock) {
      // A fence-like line here is still HTML-block content -- the block wins until it closes.
      if (htmlBlockClose) {
        if (htmlBlockClose.test(line)) {
          inHtmlBlock = false;
          htmlBlockClose = null;
        }
      } else if (/^[ \t>]*$/.test(line)) {
        inHtmlBlock = false;
      }
      continue;
    }
    if (!comment.inComment) {
      if (fence.feed(line)) continue;
      if (fence.inFence) continue;
    }
    // Obsidian parses nothing inside a <!-- --> comment; mask its span (which may open, close,
    // or run the whole line) before any other check sees this line's text. Skipped when there
    // is no comment marker anywhere near this line -- most lines, so worth the branch.
    const masked = comment.inComment || line.includes('<!--') ? comment.mask(line) : line;
    // Indented or blockquoted HTML blocks still swallow their content in Obsidian, so the
    // opener test runs after stripping leading whitespace and > markers.
    const stripped = masked.replace(/^[ \t>]*/, '');
    if (stripped[0] === '<') {
      const openMatch = HTML_BLOCK_OPEN_RE.exec(stripped);
      if (openMatch) {
        const tagName = openMatch[1].toLowerCase();
        const isClosingTag = stripped[1] === '/';
        if (!isClosingTag && HTML_PRE_TAGS.has(tagName)) {
          inHtmlBlock = true;
          // Any of the four type-1 closers ends the block, not only the tag that opened it.
          htmlBlockClose = /<\/(?:script|pre|style|textarea)>/i;
          continue;
        }
        if (HTML_BLOCK_TAGS.has(tagName)) {
          inHtmlBlock = true;
          continue;
        }
      }
    }
    if (!masked.includes('#')) continue; // most lines; skip the regex work
    let cleaned = masked.includes('`') ? maskCodeSpans(masked) : masked;
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
  schema(db) {
    db.exec('CREATE TABLE IF NOT EXISTS tags ("path" TEXT, tag TEXT, PRIMARY KEY ("path", tag))');
    db.exec('CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag)');
  },
  extract,
  // Per-file rows with nothing else to resolve, so only a vanished file needs a delete here;
  // store() below handles a reparse's stale rows itself.
  remove(db, path, delta) {
    if (!delta.vanished.includes(path)) return;
    db.prepare('DELETE FROM tags WHERE "path" = ?').run(path);
  },
  store(db, path, extracted) {
    const found = extracted as string[];
    if (found.length === 0) {
      db.prepare('DELETE FROM tags WHERE "path" = ?').run(path);
    } else {
      const placeholders = found.map(() => '?').join(', ');
      db.prepare(`DELETE FROM tags WHERE "path" = ? AND tag NOT IN (${placeholders})`).run(path, ...found);
    }
    const insert = db.prepare('INSERT OR IGNORE INTO tags ("path", tag) VALUES (?, ?)');
    for (const tag of found) insert.run(path, tag);
  },
};
