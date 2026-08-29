# Principles

What this library holds itself to. Plans cite these by number; code and tests
enforce them. A behavior change that breaks one either fixes the behavior or
changes the principle in the same PR, stating why.

## 1. Proven components; oracle-verified glue

Every algorithm and semantic contract is one of two things. Either an
independently validated component: SQLite (FTS5, its tokenizers), ECMA-402/ICU,
or an algorithm with a citation and a reference implementation (Porter 1980,
BM25, PageRank, RRF: Cormack et al. 2009, model2vec's encode convention). Or
unavoidable glue: kept minimal, and verified by diff against an independent
oracle rather than by its author's reasoning. Existing oracles:
`benchmark/oracle.mjs` against Obsidian's metadataCache for links and tags;
`String.prototype.includes` is the specification of substring semantics.
Mirroring a reference convention without a parity test against the reference
implementation is a violation of this principle, not an instance of it.

## 2. Two searches

Literal search finds what is written: every language, every script,
deterministic, no model. Semantic search finds what is meant: it exists only
when the config names a model, and its language coverage is that model's,
nothing more. They are separate capabilities that compose; neither is a
fallback for the other, and neither silently substitutes for the other.

## 3. Literal search reaches every script

FTS5's word tokenizers split on spaces, so scripts written without word spaces
are unreachable by word search unless the index supplies boundaries. The
contract: text in a supported script is findable by exact substring, and a
false negative is a bug. Where a script or query class is not covered, the
limit is documented with its escape hatch and the trade-off each hatch costs;
it is never silent.

## 4. Naming a model is consent

No `embed` block, no vectors, no downloads, zero cost. The model named in
the config is the consent to fetch it. Consent is the file's content, and
the file belongs to the tree owner whoever wrote the line, so anything that
writes a model into a config (init included) says so loudly, with the
download consequence and the prefetch command. A default English model is
safe only because misfit fails loudly (principle 6); silent degradation
would make the same default indefensible. Same config means same vectors:
weights are identified by revision, and changed weights re-embed like any
feature change.

## 5. Presets declare signals; rows name their evidence

Which signals a search composes (words, links, vectors) is per-preset
configuration, not a library constant, because no fusion policy is universally
correct: with the static model, cosine-only lost to BM25 (nfcorpus nDCG@10
0.309 vs 0.323), and with bge-small-en-v1.5 it won (0.343). Which signal helps
is model- and corpus-contingent, so the tree owner decides. Every result row
labels the signals that produced it (`via`). Costs derive from declarations: a
file earns vectors exactly when a vector-declaring preset covers it.

## 6. Misconfiguration is an error, not a mode

The same query never silently answers differently based on what happens to be
installed or reachable. Errors name the fix in the caller's terms: a config
key, a command. Provable unfitness fails loudly; unprovable fitness is never
attested. The library reports what it measured and nothing more.

## 7. Configuration has one home

Tree behavior lives in `sense.config.json`: named keys, schema-validated,
versioned, migrated. A behavior is configurable in exactly two ways: a key in
the file, or a per-invocation flag that overrides a key under the one
precedence rule (built-ins <- preset <- flags). No other channels: no
behavior-changing environment variables, no hidden defaults. Secrets are the
boundary case that proves it: the file names the env var, the value never
enters the file.

`sense init` writes the file. Its flags map one-to-one onto config keys and
are documented in `sense init --help` and the setup skill. An operation that
is not a config key, fetching a model, building an index, is a command, not
an init flag.

A key earns its place only when different trees legitimately need different
values; otherwise it is a constant or a code decision. Machine-level assets
(the model cache) have one fixed location and are not tree configuration.

## 8. Documented means tested

An integration or model named in the docs was run and verified here.
INTEGRATIONS.md holds the matrix: what was tested, against which endpoint or
model, on what date, and the README links it. Options that were not run are
not named. A remote provider's row records one extra fact: tree content
leaves the machine.
