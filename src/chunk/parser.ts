import Module from 'node:module';
import type { MarkdownIt } from 'markdown-it';
import type footnotePlugin from 'markdown-it-footnote';
import type taskListsPlugin from 'markdown-it-task-lists';

// Tier-2, as embed/static.ts: the parser's packages cost ~19 ms to load and a warm tree never
// parses, so every store-opening command paid for them until a file actually changed.
const _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;

// The CJS build resolves markdown-it's export= types, so the constructor is named locally.
type Ctor = new (options?: { html?: boolean; linkify?: boolean }) => MarkdownIt;

let cached: MarkdownIt | undefined;

// The one shared parser: html and linkify on, fuzzy links, footnotes and task lists, with the
// footnote rules disabled for GFM parity (definitions stay spans; ^[...] stays inert text).
export function parser(): MarkdownIt {
  if (cached) return cached;
  const Ctor = _require('markdown-it') as Ctor;
  const footnote = _require('markdown-it-footnote') as typeof footnotePlugin;
  const taskLists = _require('markdown-it-task-lists') as typeof taskListsPlugin;
  const md = new Ctor({ html: true, linkify: true }).use(footnote).use(taskLists);
  // Fuzzy linking is what links www. domains and emails (the scheme matcher does neither); its
  // bare-domain over-matching vs GFM is reined in at extraction, where the text is kept.
  md.linkify.set({ fuzzyLink: true });
  md.core.ruler.disable('footnote_tail');
  md.inline.ruler.disable('footnote_inline');
  cached = md;
  return cached;
}
