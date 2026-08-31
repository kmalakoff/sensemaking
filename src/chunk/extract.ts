import type { Nodes } from 'mdast';

// mdast has no wikilink, embed, or %%comment%% node -- literal text resolved by regex passes
// over non-code text (code/inlineCode is placeholder-held and spliced back verbatim, below).
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
// An html node's value is raw HTML, block or inline: a full <!-- --> comment is dropped, any
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

// Sibling blocks (list items, blockquote content, footnote bodies) joined one per line;
// empties dropped so a blank child never widens the gap between its neighbors.
function joinBlocks(nodes: Nodes[], code: string[]): string {
  return nodes
    .map((n) => extractNode(n, code))
    .filter((s) => s.length > 0)
    .join('\n');
}

// Inline content (headings, paragraphs, emphasis, links) concatenated with no separator: the
// source text nodes already carry whatever spacing separates them.
function joinInline(nodes: Nodes[], code: string[]): string {
  return nodes.map((n) => extractNode(n, code)).join('');
}

// U+E000 (Private Use Area) never appears in real markdown text, so it is a collision-free
// placeholder delimiter, spliced back to the literal code value after flavor resolution.
function codePlaceholder(value: string, code: string[]): string {
  const idx = code.push(value) - 1;
  return `\uE000${idx}\uE000`;
}

// A GFM autolink's display text is its own target, missing only the scheme
// mdast-util-gfm-autolink-literal fills into node.url (http:// for www., mailto: for an email).
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/{0,2}/i;
function isAutolink(url: string, text: string): boolean {
  return url === text || url.replace(SCHEME_PREFIX, '') === text;
}

function extractNode(node: Nodes, code: string[]): string {
  switch (node.type) {
    case 'root':
    case 'list':
    case 'listItem':
    case 'footnoteDefinition':
      return joinBlocks(node.children, code);
    case 'blockquote':
      return joinBlocks(node.children, code).replace(CALLOUT_MARKER, '');
    case 'link': {
      const text = joinInline(node.children, code);
      return isAutolink(node.url, text) ? '' : text;
    }
    case 'heading':
    case 'paragraph':
    case 'linkReference':
    case 'emphasis':
    case 'strong':
    case 'delete':
      return joinInline(node.children, code);
    case 'table':
      return node.children.map((n) => extractNode(n, code)).join('\n');
    case 'tableRow':
      return node.children.map((n) => extractNode(n, code)).join(' ');
    case 'tableCell':
      return joinInline(node.children, code);
    case 'image':
    case 'imageReference':
      return node.alt ?? '';
    case 'text':
      return node.value;
    case 'inlineCode':
    case 'code':
      return codePlaceholder(node.value, code);
    case 'html':
      return stripHtml(node.value);
    case 'break':
      return ' ';
    default:
      return '';
  }
}

const CODE_PLACEHOLDER = /\uE000(\d+)\uE000/g;

// Plain text of one mdast node (or a whole tree): heading/list/table structure is kept as text,
// markup (emphasis, link targets, task and callout markers) is dropped. Pure, synchronous.
export function extractText(node: Nodes): string {
  return extractTexts([node]);
}

// Blocks resolved together: a blank line inside %%...%% splits it across blocks, and a per-block
// strip then never sees the closing %%. Code stays placeholder-held across all of them.
export function extractTexts(nodes: Nodes[]): string {
  const code: string[] = [];
  const joined = nodes
    .map((n) => extractNode(n, code))
    .filter((s) => s.length > 0)
    .join('\n');
  const resolved = resolveFlavor(joined);
  return code.length === 0 ? resolved : resolved.replace(CODE_PLACEHOLDER, (_, i: string) => code[Number(i)]);
}
