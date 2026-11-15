# Crest continuity: next source package

This is a measured design and private prototype handoff for STORY-663 AC01,
not production integration or independent acceptance. The ordinary reader keeps
full SHA. No real library helper, lease, source mutation or installation was
used. The existing failed default CLI/Hook samples and the skip-scan criterion
remain unchanged.

## Current callers and proof gap

`readRecallCards` in `recall-inputs.ts` calls `listKnowledgeMetadataFast` in
`knowledge-read.ts`. Its `crestMetaBoundary` hashes every file through
`localTreeIdentity` before a protected `crest-meta` projection can be adopted.
The ordinary `listKnowledgeMetadata` path in `knowledge-core.ts` similarly uses
`cachedKnowledgeListScan`, current Crest heads and protected `crest`/`crest-view`
projections. Faster synchronous SHA scheduling still performs the source scan.

The complete source set includes the library Crest marker, legacy units,
stream heads, event metadata, bodies and removals; every member of each extant
directory, including unexpected/partial files; relevant archive Crest roots
from the current consolidation inventory; and named ancestry up to the root.
User Crest is independently rooted, possibly configured outside the library.
It requires its own identity and complete set, or its existing full reader.
It cannot be silently omitted or authorized by a library-root proof.

The current attestor retains leased FDs across clients but closes a transaction's
directory guard at finish/disconnect. A request constructed from an old saved
file list can therefore miss a newly added member between clients. Production
is safe because callers still enumerate; replacing that enumeration with a
saved list would introduce the gap.

## Distinguishing owned experiments

Private artifacts are under the platform-container-relative directory
`.em-093-096/codex-takeover-20261114/phase-095-lifecycle-repair/worker-evidence/`.
`crest-prototype.mjs` drives the real client, helper, same-FD SHA and native
bridge. Its private CJS bridge retains an additional complete-directory guard
across short-lived clients. Synthetic Crest-shaped files exercise continuity;
they do not stand in for parser, protected-cache or FTS semantic acceptance.

`crest-prototype-1110-report.json` records 1110 initially hashed held files,
72150 payload bytes, three distinct warm processes with no additional helper
hashes, and a new epoch rehashing all 1110 files after restart. Initial request
discovery itself also reads 72150 bytes, accounted separately. Capacity 2
refuses admission. Add/delete, restored rename, parent rename, guard loss,
external hardlink and real native mmap writes reject the retained-set proof.
All helpers are stopped and their processes are confirmed gone before fixtures
are removed. The observed large-helper RSS is about 77–84 MB; this is a fixture
measurement, not a production capacity guarantee.

`crest-prototype-64-report.json` and `crest-trace64.*` retain a smaller syscall
run, counting both helper and clients. Zero warm payload reads do not imply
zero source work: the current bridge still reopens/statx-checks every member.
Those operations are not hidden by moving them into the helper. Large-fixture
resource results and the smaller kernel counts are separate evidence scopes.
The 64-member warm sample has zero payload bytes and directory member reads,
but 192 payload-file opens and 384 source stat calls, all in the helper. The
raw/reduced trace also retains ancestry operations separately.

An external hardlink was rejected by the existing native object check while
the retained directory guard remained clean. The mmap case also depended on
native lease invalidation. `inode-watch-probe.py` independently observed
IN_ATTRIB on a held inode watch for an external link/unlink, no event on the
source directory watch, and no event for its owned mmap write. Directory guards
alone therefore cannot replace the current object checks. Inode watches alone
cannot replace leases either.

## Smallest implementable route

1. Add a concrete Crest proof namespace to the existing client/helper, preserving
   the Akasha request/lifetime. The current helper evicts FDs outside the next
   request's set: alternating independent Crest and Akasha requests must not
   share that set accidentally. Separate domain endpoints are the smaller
   alternative to a general shared-service/refcount framework. Record the extra
   process and memory cost. A separately rooted user Crest keeps its own proof
   domain; unsupported roots keep full SHA.
2. Bootstrap complete membership under persistent directory and named-ancestry
   guards, before same-leased-FD SHA and normal Crest parsing. Bind the resulting
   complete-set digest, library/root identities, head/vector, stream watermarks,
   archive provenance, projection schema/engine version, runtime/native identity
   and helper epoch to the existing protected projection. A request-supplied
   checksum or bare stat is never bootstrap authority. Absent roots require
   guarding their existing parent/name so later creation cannot be missed.
3. Retain those guards between clients and add held-inode attribute watches
   before removing per-member pathname/stat checks. Extend the native bridge
   with a Crest-specific guarded check of lease validity, F_GETLEASE and
   generation, bracketed by both complete directory and inode guard drains.
   It must perform no source-path enumeration/open/stat on the unchanged warm
   path. Preserve same-FD initial SHA, O_NOFOLLOW named ancestry, nlink/owner/
   filesystem admission and full metadata validation at bootstrap. The current
   prototype does not implement or prove that new native API.
4. Watch/queue loss, overflow, changed membership, inode attributes, writer/mmap
   break, forced revoke, unknown capability, restart or partial resource
   admission invalidate the entire affected set. Never repair a dirty guard by
   resetting its epoch while retaining old authority. Use ordinary complete
   validation and a new fully admitted set; no retry of the failed adoption.
   Parent path replacement and unrelated ancestor events remain conservative.
5. Let the two existing protected-projection boundary functions consume a live
   proof of this set instead of calling `localTreeIdentity` on a proved warm
   hit. Require a valid one-shot finish before adopting parsed/protected data.
   An unproved set still uses the existing full scan. Keep archive scope,
   conflicts, awaiting-chain/removal semantics and returned-history authority.
6. Keep freshness outside the timeless projection, recomputed from query `at`.
   Preserve the existing projection upgrade and persistent FTS reconciliation
   boundaries. Compare actual list/Recall/complete Hook and FTS rows with the
   full reader at fixed head before/after expiry and version change, including
   a card body/metadata edit and add/delete across a no-client interval.

Existing limits remain: default 4096 leases, absolute 8192, actual RLIMIT-derived
capacity, 8192 guard rules/65536 named children, 8 MiB IPC, 16 connections,
five-second transactions, 128 MiB helper heap and 256 MiB RSS retirement. New
inode watches consume real per-user watch capacity. Admission failure is full
fallback; this design raises no threshold or device policy. Read actual FD,
watch, queue and memory use rather than declaring 1110 files universally safe.

The next package must retain cold preparation and helper/client totals for
source bytes, file opens/stat calls, directory member reads, metadata, cache,
replay and delivered semantics. Warm zero source-path operations must be proved
across fresh processes and client gaps, with loss/restart negatives and owned
cleanup. Only then is current-host full-entry latency sampling useful again.
Other unmounted platforms remain unknown under the existing portable decision.
