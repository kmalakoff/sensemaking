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

Portable capability tests run one body of behavior cases with shared fixtures and independent expected results against every supported store. SQLite is a peer implementation, not the definition of correctness. Cross-store agreement and snapshots supplement those expectations; neither proves them. Native tests retain the cases needed to verify each engine's mechanisms.

Tests establish functional equivalence: supported query semantics, result shape, caller budgets, ordering where specified, and visibility of committed changes. Benchmarks compare the cost of delivering those capabilities. A faster incomplete or incorrect result is not an optimization. A shared implementation needs its own correctness oracle; exercising it through several stores proves integration, not independent agreement. A count or rounded size estimate proves only the property it records, not content identity or correctness by implication.

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

## Contracts record, they do not decide

*Invariant:* a recorded number never overrides the purpose it measures.
*Judgment:* what that purpose is.

A benchmark contract, a threshold, a captured baseline: each is a measurement
taken so a change gets noticed. Evidence, never intent. When a contract and the
purpose of the thing it measures disagree, the purpose decides, the number is
re-derived from it, and the change is stated as a change.

Tuning behavior until a number returns to its old value is the failure this
exists to prevent. It preserves the measurement and discards the thing measured,
and it looks like diligence while doing it.

A contract also carries whatever happened to be true when it was taken,
accidents included. Before treating one as a target, establish that the value
was chosen rather than inherited: a number nobody picked is a record of an
implementation, not of a decision, and re-deriving it is the correct outcome.

An explicit public bound or semantic guarantee is a correctness contract. A historical payload size, latency or relevance score is an observation unless a separate decision established it as a release requirement. Report both kinds of change, but do not enforce an incidental number by weakening the capability it measures.

## Budgets belong to the caller

*Invariant:* a bound on what a command returns is set by the caller, in a unit
that means the same thing to every consumer. *Judgment:* the default, and
whether a bound is needed at all.

Output that an agent pays for is a budget, and only the caller knows what it can
afford: the same command serves one deep read and fifty triage hits. So a bound
is a parameter with a documented default, never a constant only we can change.

The unit has to be stable across consumers. Tokens are not: one model's token is
another's three, so a token budget means something different to everyone who
calls. Characters, rows and bytes mean one thing everywhere. A unit that varies
by consumer pushes our implementation detail into their planning.

A default that cannot be derived is named as a convention, not dressed as a
measurement. Tuning a default needs an objective, and where none exists the
honest form is a stated convention in one named constant, changeable in one
place when it proves wrong.

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

## Compare like with like

*Invariant:* every comparison states and verifies the equivalence it requires. *Judgment:* which measurements inform the decision.

Cross-store analysis compares current native implementations delivering the same capability on identical logical inputs, configuration, caller budgets and declared readiness. It verifies the required result and completion state. Physical scans, query plans and representations may differ; optimizing those differences is the purpose of the comparison. Each repetition starts from the same declared state. Artifacts identify the measured code, corpus, query and configuration sufficiently to detect drift before comparison.

Historical analysis follows each store on compatible workloads and measurement boundaries. It reports improvements and regressions per capability and summarizes their extent and comparison coverage over time. A changed workload starts a new series rather than inheriting incompatible numbers. Missing historical priors limit historical conclusions, not valid current cross-store comparisons. Neither a missing prior nor an invalid measurement counts as a successful comparison.

A store's ranking can select different notes and change the downstream work. Separate native retrieval from fixed-candidate hydration when comparing those costs, and validate candidate identities, not just their count. Combined measurements retain their selected paths and output sizes and are labelled as per-store end-to-end diagnostics. Ranking quality is itself comparable against common queries and independently judged relevance labels; different rankings are the result being evaluated, not grounds to omit that comparison.

Show absolute costs, relative differences, repeat variability and workload size together. A large ratio on a tiny operation may matter less than a small ratio on a dominant cost. Summaries name the eligible rows and omitted coverage, keep unlike units separate, and do not let an aggregate conceal a specific regression. Timings locate a cost; a targeted measurement or controlled change establishes its cause.

Equivalence is of capability, never of implementation. Making stores agree by
moving them all onto one engine's approach, or onto the weakest available, trades
the reason for having three stores for a number that looks tidy. Where an engine
is slower on identical work, that is the finding the benchmark exists to produce.

A test that asserts stores agree is not a test that they are right. Agreement is
checked against an independent oracle, never against each other alone.

## Validity before performance

*Invariant:* incorrect behavior or invalid required evidence cannot establish release readiness. *Judgment:* which performance costs justify delaying a release.

The instrument proves successful execution and required coverage before classifying a value. It records every repetition's failures and every required store or query that did not run. A retrieval error is not an empty result, an absent reading is not zero, and an omitted store is not a passing store. Legitimate empty results have an explicit expected meaning. An environment responsible for a capability fails when that capability is missing; a partial run names what remains unverified.

Correctness, measurement validity, comparison eligibility and release severity are separate properties. Failed required capability tests, missing required coverage and invalid required evidence block. Performance and historical size or relevance movements normally produce visible warnings for review; being slower than another store is an optimization finding, not a functional failure. A performance block needs an explicit user-impact requirement, a repeatable measurement and an approved guard. Historical bands detect movement; their existence alone does not make every movement a release blocker. An explicit quality floor or caller budget remains a requirement, not a warning.

Collect independent findings in one run. Failed prerequisites prevent only the work that needs them, and the report names what was not measured. Reuse completed work on unchanged inputs when resuming. Tests exercise classification and recovery through the actual final report; a row label or successful child exit cannot establish the verdict. Warning-only performance policy never converts an invocation error into a usable timing.

A release acceptance applies to the identified measurement and reason. A changed workload or invalid instrument requires new evidence before that acceptance can be applied again. It does not authorize incomplete required coverage or establish correctness. Warnings remain visible without requiring ceremonial overrides for every historical movement.

## Native, not emulated

*Invariant:* shared capability contracts hold across stores. *Judgment:* each engine's implementation should use its strengths.

A store implements the contract with its engine's own mechanisms, not a
simulation of another store's: SQLite uses FTS5 and its UDFs, DuckDB uses its
fts extension and vector types; Turso uses Tantivy FTS and native vector storage.
The execution strategy is measured per engine; native storage does not imply that pushing every operation into SQL is faster.
Normalization lives at the exported API, the Store interface, named errors,
and result shapes. A SQL translation layer that makes one engine speak
another's dialect is a violation, however uniform the output looks.

Native ranking scores may differ where the public contract permits them; evaluate their relevance rather than forcing identical arbitrary scores or top-k order. Required membership, phrase behavior, output shape and specified tie rules still need shared tests. A store-specific extension or genuine engine limitation is named where the caller can act on it and covered by a capability test. Declaring a limitation does not silently remove a requirement from the common contract.

Divergence that originates above the Store interface is a defect in shared
code, fixed there. The declare-and-surface path is for a limit in the engine,
not for shared code that leaked one.

An observed difference is evidence to investigate, not permission to weaken the capability contract. Establish the engine limit and obtain the owner's decision before accepting a public semantic difference. Score tolerances need an independent numerical justification; rounding two scores alike does not establish equivalent ordering.

## Evidence proportional to the decision

*Judgment, subordinate to correctness and validity:* build the smallest instrument that can answer the current decision.

Reuse shared behavioral cases, the existing measurement boundaries and retained raw evidence. Add a fixture, metric or abstraction when it answers a named unresolved question, not to preserve every historical mechanism. Old reports can remain readable historical evidence without making their schemas or workloads part of the current execution path.

Optimization proceeds in bounded steps: locate a material cost, verify its cause, change the native or shared component that owns it, then recheck the same capability and workload. Broader workload matrices and unproved optimizations belong in future work unless a current requirement makes them necessary. A useful warning and a concrete follow-up can be a complete outcome; an unmeasured correctness claim cannot.

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
