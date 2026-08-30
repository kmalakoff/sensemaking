// Signal names a search can compose and each one's prerequisite; the single source config
// validation and search composition both read. A preset with an unmet prerequisite errors naming both keys.
export const SIGNAL_NAMES = ['words', 'links', 'vectors'] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];

// A preset's signals, declared or effective: which fire, and each one's RRF weight (presence is
// enablement). Weight multiplies the RRF contribution (weight / (RRF_K + rank)); weight 1 reproduces pre-weight scores bit-for-bit.
export type SignalWeights = Partial<Record<SignalName, number>>;

// links is seeded by word-match rows, so it is empty without them. vectors' prerequisite is a
// named embed model, not another signal -- validate.ts checks that against the top-level embed block directly.
export const SIGNAL_PREREQUISITES: Partial<Record<SignalName, SignalName>> = { links: 'words' };
