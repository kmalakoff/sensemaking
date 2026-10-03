# Sense terminology

This is the shared vocabulary for Sense's README, command help, API documentation and skills. Use these names when describing results and output controls.

| Term | Meaning |
|---|---|
| Note | One Markdown file. A document is the same unit; SQL and some status fields use that name. |
| Tree | The directory of notes configured as Sense's root. |
| Frontmatter | The YAML metadata at the beginning of a note, such as its title, tags or status. |
| Search result | One matching note, returned with its path, ranking information and any snippets. A result is not a section or a chunk. |
| Snippet | A short passage selected around matching words, marked with `«»`. A note can return multiple snippets. A snippet need not contain a whole section. |
| Heading | A Markdown heading such as `## Installation`. Its level is its depth, from 1 to 6. |
| Section | A heading and the content following it until the next heading of any level, or the end of the note. Text before the first heading is not a section in the `sections` table. A parent section does not include subsequent subsections. |
| Section description | The heading text, level, start and end lines, and estimated token count returned by `peek`. It does not contain the section's prose. |
| Outline | The section descriptions in document order. It is a view of the note's structure, not another stored type of content. |
| Chunk | A span of note content prepared for embedding. Chunking follows document structure and a token budget; a chunk is not necessarily one section or one snippet. |
| Line range | Inclusive, one-based lines in the indexed source note, such as `L12-28`. Search can point to a section or an embedding chunk. A null range provides no narrower location. |
| Outbound link | A link from the current note to another indexed note. `peek.outbound` returns distinct destination paths. |
| Backlink | A link from another indexed note to the current note. `peek.backlinks` returns distinct source paths. |
| Unresolved link | A written link target that did not resolve to an indexed note. This does not establish that the link is broken: attachments and notes outside the index can also be unresolved. `peek.unresolved` returns written targets. |
| Scope | The indexed notes selected for an operation by its preset and filters. Scope is not an access-control boundary. |
| Search signal | One source of ranking evidence: word matches, link relationships or vector similarity. A signal's rank is a candidate's position within that signal, not the final combined position. |

## Reading a section description

The illustrative entry `## Installation [L12-28, ~90t]` describes a section headed “Installation”, starting at line 12 and ending at line 28, with an estimated 90 tokens. `peek` returns that description. Reading the indicated lines retrieves the content. With nested headings, the description ends before the next heading, even when that heading is deeper.

## Naming output controls

Name the object and the unit: a snippet count is how many passages are returned; a snippet character limit controls passage length; a section count is how many section descriptions are returned; a link count controls link entries. A count limit is not pagination. An offset, when supported by an operation, skips entries before returning the requested count. Raw SQL supports `LIMIT` and `OFFSET`; search and peek do not currently expose offset options.

Peek count limits request prefixes of the ordered section and link lists. Each search or peek reads one committed index snapshot; separately issued operations can observe later commits. See [finite retrieval and paging](search.md#finite-retrieval-and-paging) for search budgets and paging retained results.
