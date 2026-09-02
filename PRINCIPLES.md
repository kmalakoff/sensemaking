# Principles

What this library holds itself to. Plans cite these; code and tests enforce
them. A behavior change that breaks one either fixes the behavior or changes
the principle in the same PR, stating why.

Cite by name, never by number: `(PRINCIPLES: no-silent-modes)`, one form
everywhere so a check can verify every cited name is a real heading here. The
name is the heading, lowercased, punctuation dropped, spaces hyphenated.
Renaming is allowed and expected as principles are reworked: a stale name
resolves to nothing and a grep finds it, where a stale number would resolve to
the wrong principle silently. Plans are dated records, so a plan keeps the name
it cited.

A principle may also be added for behavior that was never examined before.
Discovering that existing behavior violates it is the normal case, not a
reason to weaken it: the principle is stated plainly and the work to close the
gap goes in a plan. A principle is never softened, and never given an exception
clause, to make current behavior pass. When a principle genuinely proves wrong,
it is changed here, on its own merits, not to accommodate one violation.

Each principle states its force. An invariant holds without exception; where
two appear to conflict, one is being misread. A judgment call is a position
this library takes, and it yields to an invariant every time. Two judgment
calls in tension are settled by measurement, not by argument.

## Proven or verified

*Invariant.* Nothing outranks the standard of proof.

Every algorithm and semantic contract is one of two things. Either an
independently validated component: SQLite (FTS5, its tokenizers), ECMA-402/ICU,
or an algorithm with a citation and a reference implementation (Porter 1980,
BM25, PageRank, RRF: Cormack et al. 2009, model2vec's encode convention). Or
unavoidable glue: kept minimal, and verified by diff against an independent
oracle rather than by its author's reasoning. Existing oracles:
`benchmark/steps/oracle.mjs` against Obsidian's metadataCache for links and tags;
`String.prototype.includes` is the specification of substring semantics.
Mirroring a reference convention without a parity test against the reference
implementation is a violation of this principle, not an instance of it.

Across stores, sqlite is the reference implementation every other store is
diffed against (`test/integration/store-parity.test.ts`). That is a parity
baseline, not an independent oracle: it is code in this repo, and the other
engines are independently validated too.

## Two searches

*Invariant:* neither search substitutes for the other. *Judgment:* which
signals a query composes (declared-signals decides).

Literal search finds what is written: every language, every script,
deterministic, no model. Semantic search finds what is meant: it exists only
when the config names a model, and its language coverage is that model's,
nothing more. They are separate capabilities that compose; neither is a
fallback for the other, and neither silently substitutes for the other.

## Substring findability

*Invariant:* a false negative in a covered script is a bug. *Judgment:*
which scripts and query classes are covered, declared and never silent.

FTS5's word tokenizers split on spaces, so scripts written without word spaces
are unreachable by word search unless the index supplies boundaries. The
contract: text in a supported script is findable by exact substring, and a
false negative is a bug. Where a script or query class is not covered, the
limit is documented with its escape hatch and the trade-off each hatch costs;
it is never silent.

## Naming is consent

*Invariant.* Nothing is fetched that the config did not name.

No `embed` block, no vectors, no downloads, zero cost. The model named in
the config is the consent to fetch it. Consent is the file's content, and
the file belongs to the tree owner whoever wrote the line, so anything that
writes a model into a config (init included) says so loudly, with the
download consequence and the prefetch command. A default English model is
safe only because misfit fails loudly (no-silent-modes); silent degradation
would make the same default indefensible.

## Declared signals

*Judgment.* Measured per corpus and model; the tree owner decides.

Which signals a search composes (words, links, vectors) is per-preset
configuration, not a library constant, because no fusion policy is universally
correct: with the static model, cosine-only lost to BM25 (nfcorpus nDCG@10
0.309 vs 0.323), and with bge-small-en-v1.5 it won (0.343). Which signal helps
is model- and corpus-contingent, so the tree owner decides. Every result row
labels the signals that produced it (`via`). Costs derive from declarations: a
file earns vectors exactly when a vector-declaring preset covers it.

## No silent modes

*Invariant.* No judgment call buys its way past this one.

The same query never silently answers differently based on what happens to be
installed or reachable. Errors name the fix in the caller's terms: a config
key, a command. Provable unfitness fails loudly; unprovable fitness is never
attested. The library reports what it measured and nothing more.

## One config home

*Judgment, with a bar:* a key earns its place only when different trees
legitimately need different values.

Tree behavior lives in `sense.config.json`: named keys, schema-validated,
versioned, migrated. A behavior is configurable in exactly two ways: a key in
the file, or a per-invocation flag that overrides a key under the one
precedence rule (built-ins <- preset <- flags). No other channels: no
behavior-changing environment variables, no hidden defaults. Secrets are the
boundary case that proves it: the file names the env var, the value never
enters the file.

An operation that is not a config key, fetching a model, building an index,
is a command, not an init flag.

A key that does not clear that bar is a constant or a code decision.
Machine-level assets (the model cache) have one fixed location and are not
tree configuration.

## Documented means tested

*Invariant.*

An integration or model named in the docs was run and verified here.
INTEGRATIONS.md holds the matrix: what was tested, against which endpoint or
model, on what date, and the README links it. Options that were not run are
not named. A remote provider's row records one extra fact: tree content
leaves the machine.

## Native, not emulated

*Judgment:* engine-native costs uniformity and is worth it. *Invariant:*
the difference is never silent.

A store implements the contract with its engine's own mechanisms, not a
simulation of another store's: SQLite uses FTS5 and its UDFs, DuckDB uses its
fts extension and vector types; a future Turso store would use Tantivy FTS
and vector distances.
Normalization lives at the exported API, the Store interface, named errors,
and result shapes. A SQL translation layer that makes one engine speak
another's dialect is a violation, however uniform the output looks.

Native engines differ, and no-silent-modes forbids the same query answering
differently. The word that resolves it is *silently*. Where an engine cannot
match the reference (proven-or-verified), the difference is measured against
it and declared where it can be acted on: a capability when the behavior is
gateable, otherwise the store's docs plus a parity case that pins it. It is
never emulated away, and never left silent. A silent per-store difference
violates this principle and no-silent-modes at once, and is the failure mode
both exist to prevent.

Divergence that originates above the Store interface is a defect in shared
code, fixed there. The declare-and-surface path is for a limit in the engine,
not for shared code that leaked one.

## Proportional invalidation

*Judgment, subordinate:* cost never wins a tie against naming-is-consent
or no-silent-modes.

A derived artifact is discarded only by a change to something it actually
derives from. What invalidates what is one rule every store obeys; how a store
maintains its own indexes is the store's own business (native-not-emulated).
Discarding an expensive artifact on an unrelated change is a defect, not a
conservative default, and embeddings are the expensive artifact. The inverse is
worse: a stale artifact kept through a change it depended on is a wrong answer.
So provable freshness is preserved; unprovable freshness rebuilds, and an
unrecognized input rebuilds rather than being assumed harmless.

Same config means same vectors: weights are identified by revision, and
changed weights re-embed. A change vectors never derived from does not.
