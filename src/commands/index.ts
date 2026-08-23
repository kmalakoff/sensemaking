// The three commands: mapTree (orient), search (locate), peek (structure).
// Each returns data; cli.ts renders. All of them degrade when a feature is off.

export type { TreeMap } from './map.ts';
export { mapTree } from './map.ts';
export type { Peek } from './peek.ts';
export { peek, resolveNote } from './peek.ts';
export { relatedNotes } from './related.ts';
export { scopedPaths } from './scope.ts';
export type { SearchOptions } from './search.ts';
export { search } from './search.ts';
export type { PresetCoverage } from './status.ts';
export { presetCoverage } from './status.ts';
