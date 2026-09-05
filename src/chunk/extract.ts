import type { Token } from 'markdown-it';
import { parser } from './parser.ts';
import type { Block } from './types.ts';

// markdown-it, like mdast, has no wikilink, embed, or %%comment%% token -- literal text resolved
// by regex passes over non-code text (code/inline code is placeholder-held and spliced back verbatim).
const COMMENT_PAIR = /%%[\s\S]*?%%/g;
// An embed always yields its target, whatever follows a pipe (a resize suffix, never an alias);
// must run before the wikilink regex below, bang included, or that regex matches first.
const EMBED = /!\[\[([^\]]+)\]\]/g;
const WIKILINK = /\[\[([^\]]+)\]\]/g;
// A trailing " ^id" is an Obsidian block anchor, valid only at a line's end; a caret elsewhere
// (mid-line) is ordinary text and is left alone.
const BLOCK_ID = / \^[A-Za-z0-9-]+$/gm;
// A callout marker is only ever the first thing in a blockquote's text (Obsidian's grammar),
// so this anchors to blockquote output alone -- never applied to prose in general.
const CALLOUT_MARKER = /^\[!\w[\w-]*\][+-]?[ \t]?/;
// An html token's content is raw HTML, block or inline: a full <!-- --> comment is dropped, any
// remaining tags are stripped, and the text a browser would still render survives.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<[^>]+>/g;

function stripHtml(value: string): string {
  return value.replace(HTML_COMMENT, '').replace(HTML_TAG, '');
}

// A `#anchor` keeps its text (hash dropped), unlike links.ts's parseWikilinkInner (the resolver
// authority), which discards it entirely -- replicated here since that return value doesn't fit.
function anchorText(base: string): string {
  const hashIdx = base.indexOf('#');
  if (hashIdx === -1) return base.trim();
  const target = base.slice(0, hashIdx).trim();
  const anchor = base.slice(hashIdx + 1).trim();
  return target ? `${target} ${anchor}` : anchor;
}

function wikilinkText(inner: string): string {
  const pipeIdx = inner.indexOf('|');
  return pipeIdx === -1 ? anchorText(inner) : inner.slice(pipeIdx + 1).trim();
}

function embedText(inner: string): string {
  const pipeIdx = inner.indexOf('|');
  return anchorText(pipeIdx === -1 ? inner : inner.slice(0, pipeIdx));
}

function resolveFlavor(text: string): string {
  return text
    .replace(HTML_COMMENT, '')
    .replace(COMMENT_PAIR, '')
    .replace(EMBED, (_, inner: string) => embedText(inner))
    .replace(WIKILINK, (_, inner: string) => wikilinkText(inner))
    .replace(BLOCK_ID, '');
}

// U+E000 (Private Use Area) never appears in real markdown text, so it is a collision-free
// placeholder delimiter, spliced back to the literal code value after flavor resolution.
function codePlaceholder(value: string, code: string[]): string {
  const idx = code.push(value) - 1;
  return `\uE000${idx}\uE000`;
}

// GFM's autolink literal ends where its path machine stops: a trail of punctuation is a genuine
// end (link stops before it) only when trailEndsAt accepts it, else the marks are part of the link.
const PUNCT = new Set(['!', '"', '&', "'", ')', '*', ',', '.', ';', ':', '<', '?', '_', '~', ']']);
const TRAIL_PUNCT = new Set(['!', '"', "'", ')', '*', ',', '.', ';', ':', '?', '_', '~']);
const isAlpha = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
function trailEndsAt(s: string, j: number): boolean {
  for (;;) {
    const c = s[j];
    if (c === undefined) return true;
    if (TRAIL_PUNCT.has(c)) {
      j += 1;
      continue;
    }
    if (c === '&') {
      j += 1;
      if (!isAlpha(s[j])) return false;
      j += 1;
      while (isAlpha(s[j])) j += 1;
      if (s[j] !== ';') return false;
      j += 1;
      continue;
    }
    if (c === ']') {
      j += 1;
      const d = s[j];
      return d === undefined || d === '(' || d === '[' || /\s/u.test(d ?? ' ');
    }
    if (c === '<') return true;
    if (c !== undefined && /^\s$/u.test(c)) return true;
    return false;
  }
}
// Where the GFM autolink ends in S (the linkifier's text plus the following text), old-style:
// punctuation that fails the trail test, or a ) with closes <= opens, extends the link.
function gfmAutolinkEnd(s: string): number {
  let open = 0;
  let close = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') {
      open += 1;
      continue;
    }
    if (c === ')' && close < open) {
      close += 1;
      continue;
    }
    if (PUNCT.has(c) && trailEndsAt(s, i)) return i;
    if (c !== undefined && /^\s$/u.test(c)) return i;
  }
  return s.length;
}
// linkify-it links more than GFM's autolink literal (bare domains, ftp://, //host); only the
// GFM forms (http(s)://, www., email) drop their text.
function isGfmUrl(text: string): boolean {
  return /^https?:\/\//i.test(text) || /^www\./i.test(text);
}
// Only a bare address is GFM's email autolink: a url keeps its @, since a path can hold one.
function isGfmEmail(text: string): boolean {
  return !isGfmUrl(text) && text.includes('@');
}
// The task-lists plugin injects its checkbox as the item's first inline child.
function isTaskCheckbox(token: Token | undefined): boolean {
  return token?.type === 'html_inline' && /^<input\b/i.test(token.content);
}
// A linkify span can swallow the & of a following entity (span ...c& + text amp; z); the
// re-emitted lead is then a reference the entity rule never saw, so decode it old-style.
const LEAD_ENTITY = /^&[a-z#][a-z0-9]{1,31};/i;

// Split a flat token range into its top-level blocks: nesting 1 opens, nesting 0 is one block.
function topLevelBlocks(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.nesting === 1) {
      let depth = 1;
      let j = i + 1;
      while (j < tokens.length && depth > 0) {
        depth += tokens[j].nesting === 1 ? 1 : tokens[j].nesting === -1 ? -1 : 0;
        j += 1;
      }
      out.push(tokens.slice(i, j));
      i = j;
    } else if (token.nesting === 0) {
      out.push(tokens.slice(i, i + 1));
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

// A first line with no source content (a bare task checkbox, whitespace) contributes no line to
// the value, so its softbreak is dropped; a first line whose content extraction removes (an
// autolink, an image) still leaves its line ending behind.
function paragraphText(children: Token[], code: string[]): string {
  let k = 0;
  const first = children[0];
  if (isTaskCheckbox(first)) k = 1;
  while (k < children.length && children[k].type === 'text' && children[k].content.trim() === '') k += 1;
  if (k > 0 && children[k]?.type === 'softbreak') return inlineText(children.slice(k + 1), code);
  return inlineText(children, code);
}

function blockText(tokens: Token[], code: string[]): string {
  const first = tokens[0];
  if (!first) return '';
  switch (first.type) {
    case 'heading_open':
    case 'paragraph_open': {
      const inline = tokens.find((t) => t.type === 'inline');
      return inline ? paragraphText(inline.children ?? [], code) : '';
    }
    case 'fence':
    case 'code_block':
      // Fence and indented code tokens carry the closing newline their lines were joined with.
      return codePlaceholder(first.content.replace(/\n$/, ''), code);
    case 'table_open':
      return tableText(tokens, code);
    case 'ordered_list_open':
    case 'bullet_list_open':
      return listItemsText(tokens, code);
    case 'blockquote_open':
      return blocksIn(tokens.slice(1, -1), code).replace(CALLOUT_MARKER, '');
    case 'html_block':
      // A non-final-line html block carries its last line's terminator, which the mdast value lacked.
      return stripHtml(first.content.replace(/\n$/, ''));
    case 'footnote_reference_open':
      return blocksIn(tokens.slice(1, -1), code);
    default:
      return '';
  }
}

// Sibling blocks (list items, blockquote children, footnote bodies) joined one per line;
// empties dropped so a blank child never widens the gap between its neighbors.
function blocksIn(tokens: Token[], code: string[]): string {
  return topLevelBlocks(tokens)
    .map((b) => blockText(b, code))
    .filter((s) => s.length > 0)
    .join('\n');
}

// The task-lists plugin slices 3 of the marker's 4 chars, leaving its trailing space on the text
// after the checkbox token. Returns a copy with that space dropped, never a mutation: a block is
// extracted more than once (parse pre-extracts headings, group.ts extracts again).
function withoutTaskMarker(item: Token[]): Token[] {
  for (let i = 0; i < item.length; i++) {
    const token = item[i];
    // The checkbox, if any, sits in the item's first inline only.
    if (token.type !== 'inline' || !token.children?.length) continue;
    const second = token.children[1];
    if (!isTaskCheckbox(token.children[0]) || second?.type !== 'text' || !second.content.startsWith(' ')) return item;
    const children = token.children.slice();
    children[1] = { ...second, content: second.content.slice(1) } as Token;
    const copy = item.slice();
    copy[i] = { ...token, children } as Token;
    return copy;
  }
  return item;
}

function listItemsText(tokens: Token[], code: string[]): string {
  const items: string[] = [];
  for (const item of topLevelBlocks(tokens.slice(1, -1))) {
    items.push(blocksIn(withoutTaskMarker(item).slice(1, -1), code));
  }
  return items.filter((s) => s.length > 0).join('\n');
}

// Table rows joined by newline, cells by space (mdast's tableRow/tableCell joiners).
function tableText(tokens: Token[], code: string[]): string {
  const rows: string[] = [];
  let cells: string[] = [];
  for (const token of tokens) {
    if (token.type === 'tr_open') cells = [];
    else if (token.type === 'inline') cells.push(inlineText(token.children ?? [], code));
    else if (token.type === 'tr_close') rows.push(cells.join(' '));
  }
  return rows.join('\n');
}

// Inline content (headings, paragraphs, emphasis, links) concatenated with no separator: the
// source text tokens already carry whatever spacing separates them.
function inlineText(tokens: Token[], code: string[], inAlt = false): string {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'link_open') {
      let skip = 0;
      let j = i + 1;
      let depth = 1;
      while (j < tokens.length && depth > 0) {
        if (tokens[j].type === 'link_open') depth += 1;
        else if (tokens[j].type === 'link_close') depth -= 1;
        j += 1;
      }
      const text = inlineText(tokens.slice(i + 1, j - 1), code, inAlt);
      const markup = token.markup;
      const next = tokens[j];
      if (inAlt) {
        // An image's alt is plain text: mdast kept every link's own text there, autolinks included.
        out += text;
      } else if (markup === 'linkify' && isGfmUrl(text)) {
        // GFM drop: the next text token resumes at the old link's boundary, re-emitting any
        // trimmed trail. <www.x> has no trail to absorb (the brackets bound it), keep the >.
        // Emails keep their whole remainder: GFM's email machine has no trail, so the span
        // already ends at the old boundary and the entity rule has decoded the rest.
        const prev = tokens[i - 1];
        const bracketed = prev?.type === 'text' && prev.content.endsWith('<') && next?.type === 'text' && next.content.startsWith('>');
        const tail = next?.type === 'text' ? text + next.content : text;
        const k = bracketed ? text.length : gfmAutolinkEnd(tail);
        out += tail.slice(k).replace(LEAD_ENTITY, (m) => parser().utils.unescapeAll(m));
        // The trail came out of the next text token, so that token is consumed here, not re-read.
        if (next?.type === 'text') skip = 1;
      } else if (markup === 'linkify' && isGfmEmail(text)) {
        // Email drop: nothing after the span to trim, so the span alone is dropped.
      } else if (markup === 'autolink') {
        // <...> leaf: dropped whole, its brackets live inside the token so nothing follows to trim.
      } else {
        out += text; // user link or non-GFM linkify target: keep the display text
      }
      i = j - 1 + skip;
    } else if (token.type === 'text') {
      out += token.content;
    } else if (token.type === 'softbreak') {
      out += '\n';
    } else if (token.type === 'hardbreak') {
      out += ' ';
    } else if (token.type === 'code_inline') {
      out += codePlaceholder(token.content, code);
    } else if (token.type === 'html_inline') {
      out += stripHtml(token.content);
    } else if (token.type === 'image') {
      out += inlineText(token.children ?? [], code, true);
    }
    // Emphasis, strikethrough and footnote markers carry no text of their own.
  }
  return out;
}

const CODE_PLACEHOLDER = /\uE000(\d+)\uE000/g;

// Plain text of one parsed block: heading/list/table structure is kept as text, markup (emphasis,
// link targets, task and callout markers) is dropped. Pure, synchronous.
export function extractText(block: Block): string {
  return extractTexts([block]);
}

// Blocks resolved together: a blank line inside %%...%% splits it across blocks, and a per-block
// strip then never sees the closing %%. Code stays placeholder-held across all of them.
export function extractTexts(blocks: Block[]): string {
  const code: string[] = [];
  const joined = blocks
    .map((b) => blockText(b.node, code))
    .filter((s) => s.length > 0)
    .join('\n');
  const resolved = resolveFlavor(joined);
  return code.length === 0 ? resolved : resolved.replace(CODE_PLACEHOLDER, (_, i: string) => code[Number(i)]);
}
