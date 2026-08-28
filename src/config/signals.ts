// Signal names a search can compose and each one's prerequisite among the others. The
// single source both config validation and search composition read: a preset that declares a
// signal whose prerequisite is unmet gets an error naming both keys, not a quieter result.
export const SIGNAL_NAMES = ['words', 'links', 'vectors'] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];

// A preset's signals, declared or effective: which ones fire and each one's RRF weight. Presence
// is enablement -- a signal absent from the map never runs. Weight multiplies that signal's
// RRF contribution (weight / (RRF_K + rank)); weight 1 is the default and reproduces pre-weight
// scores bit-for-bit.
export type SignalWeights = Partial<Record<SignalName, number>>;

// links is seeded by word-match rows, so it is empty without them. vectors' prerequisite is a
// named embed model, not another signal, so validate.ts checks it against the top-level embed
// block directly instead of listing it here.
export const SIGNAL_PREREQUISITES: Partial<Record<SignalName, SignalName>> = { links: 'words' };
