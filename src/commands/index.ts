// The three commands: mapTree (orient), search (locate), peek (structure).
// Each returns data; cli.ts renders. All of them degrade when a feature is off.

export type { TreeMap, TreeMapField, TreeMapHub, TreeMapRecent } from './map.ts';
export { mapTree } from './map.ts';
export type { PathOptions } from './path.ts';
export { findPath } from './path.ts';
export type { Peek, PeekSection } from './peek.ts';
export { peek, resolveNote } from './peek.ts';
export type { RelatedOptions, RelatedResult } from './related.ts';
export { relatedNotes } from './related.ts';
export { scopedPaths } from './scope.ts';
export type { SearchOptions, SearchResult, SearchResultVia } from './search.ts';
export { search } from './search.ts';
export type { PresetCoverage } from './status.ts';
export { presetCoverage } from './status.ts';
