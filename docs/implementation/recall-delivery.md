# Recall clause delivery

Recall keeps the record as the ranking unit and carries the matching decision's
number, text, validity, scope and stable source into the hit. A clause index keeps
a technical query from being diluted by the other decisions in a long minutes
record. Its scores use the query's actual clause and record frequencies, so common
terms in a small clause corpus cannot acquire artificial record-level rarity. Full identifiers
and their case/underscore/hyphen subwords are indexed together. The tokenizer used
by conflict detection is unchanged.

Identifier expansions use a separate index route so they cannot change unrelated
prose scores through length normalization. Short clause queries must match their
constraints together; a complete clause match receives a 1.1 multiplier.

Long prose queries use at most 48 informative terms. Without a title, summary or
authored expansion anchor, their scores scale by coverage of the complete query,
including terms absent from the corpus. Explicit
external keys retain their existing priority. The strong-hit threshold, relative
floor and prompt budget retain their existing values.

The state adapter constructs a Work current contract from its current summary,
goal, acceptance, required requirements, constraints and valid associated decisions.
Legacy prose before a history/revision/progress heading remains searchable;
annotation history stays available through work-show and work-content-context.
A terminal current contract has a score multiplier of 0.85 for action queries;
explicit keys and historical queries retain their priority. Akasha records and
conflict/scope admission are unchanged.

Minutes lines label current validity or historical intent, state their project
scope (or the minutes-local scope of a legacy compact fixture), include a clause
excerpt and retain a complete minutes-show locator. Excerpts reserve source bytes
before shortening prose. Empty titles, bare keys/numbers and empty summary shells
are not injected. A line that does not fit is skipped; later candidates still
compete for the remaining bytes. Returning no line is legitimate when no complete
line fits. CLI records remain diagnostic and do not prove injection.

The decision-delivery freeze supplements the existing retrieval-eval corpus and
floors. Its source-derived public regression questions are not independent blind
user prompts. Development and tuning are scored before holdout; holdout sources
are disjoint and are not used to choose parameters. Snapshot sources may coexist
in the disposable evaluation library even when their prose overlaps; this is a
fixture import declaration, not a new live-chain decision.

The evaluator calls the normal CLI with --view agent and checks the actual context
for the expected D number, validity, excerpt, scope and complete expandable source.
It separately reports record Top-3, actual clause delivery, budget omissions,
ranked records without the expected clause, obsolete clauses injected as current,
historical correctness, legal empty results, invalid empty results and unrelated
false injections. The content-addressed manifest and existing threshold policy
bind the cases and floors before scoring. Byte drift and private text refuse by
name. Recording and scoring run with the filesystem write tripwire over the
fixture library, with before/after byte digests. Raw outputs stay in the caller's
private output directory.
