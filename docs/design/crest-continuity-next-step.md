# Crest source-set continuity

The optional Linux attestor now supplies a Crest-specific complete source-set
proof to ordinary knowledge lists and Recall's metadata path. This is an
implementation candidate with implementation self-checks, not independent
acceptance, production enablement or a new real-mount performance result.
The default reader still uses full SHA. The existing explicit
`EINZBERN_SOURCE_ATTESTOR_ROOT` selection is required; no new safety switch,
mandatory addon, startup build, installation hook or global service is added.

## Admission and continuity

`crest-source-proof.ts` binds the already validated raw workspace replay,
manifest, device, head, version vector, stream declarations, consolidation
provenance and projection version. The existing client hashes the actual
runtime host/addon and separates Crest root collections from Akasha endpoints.
Their retained leases cannot evict one another. The live projection binding
also includes the complete set digest, helper epoch, generation and lease
incarnations. A checksum in a writable cache or a client file declaration is
not initial authority.

The helper's `CrestSourceSet` guards each existing parent/name before testing
its child. It watches every directory before enumerating it, then admits all
members, including unexpected and partial names. Missing roots retain their
existing parent/name guard. The set covers marker, legacy units, heads, event
metadata, bodies, removals and the relevant archived Crest roots selected by
the validated consolidation inventory. An unadmittable member makes the entire
proof miss; the ordinary reader still receives the original inputs. User Crest
keeps its separately rooted and authorized full reader.

Initial native admission retains O_NOFOLLOW component traversal, regular file,
nlink=1, owner, reviewed filesystem, held-fd/current-name identity and a real
read lease. `acquireCrest` installs the held-inode watch before the final full
held/current-name admission. The helper then hashes that same leased fd through
EOF and checks its length; persistent guards and native lease checks protect
the following parser/adoption interval. This catches an
external hardlink that directory watches cannot observe. Writable descriptors
and mappings deny initial leases; later breaks invalidate in the native signal
handler before unlocking, even while JavaScript is busy. Inotify does not prove
mmap content continuity.

`guardAdd` extends discovery guards; `guardHold` observes held inodes;
`guardedCheck` brackets held-lease/F_GETLEASE and generation checks with drains
of the persistent guard. An unchanged warm check performs no member open,
stat, path-stat or enumeration. The guards and leases survive short-lived
clients. Dirty queues, overflow, ignored/lost watches, rename, replacement,
attribute/content changes, revoked leases, incomplete adoption, disconnect,
restart or unknown capabilities retire the entire set. Rebuilding requires a
new complete admission, with no retry of the failed one-shot adoption.

Directory and inode watches do not establish a client's mount view. The client
and helper sample namespace, filesystem root identity and the **complete**
mountinfo bytes before/after begin and finish. The helper independently reads
these through the PID obtained from the Unix socket's kernel SO_PEERCRED, not a
request-supplied PID. Different namespaces, source subtree overmounts, changed
mount collections or unreadable/unstable observations cause full fallback.
Cold admission also compares each native directory/file mount ID with its
expected mount in that captured complete table, so a transient overmount cannot
seed leases for a different named view. An ambiguous mount stack falls back.
These finite process/root observations do not add warm member path checks. Namespace
creation for tests remains confined to owned fixtures; host mounts are untouched.

Cold collection uses bounded, authenticated `crest-next` preparation steps at
the existing 16-member reader quantum. Each exchange keeps the 1500ms IPC
deadline; preparation, parsing and one-shot adoption share the original
five-second transaction. Partial sets cannot authorize projections and are
released on cancellation, disconnect or expiry. Warm adoption uses no such loop.

## Projection adoption and full fallback

`listKnowledgeMetadataFast` probes a live set before `crestMetaBoundary` and
`readProtectedProjection("crest-meta")`. Cold/missing sets continue into the
ordinary reader. `cachedKnowledgeListScan` binds `crest`, `crest-view` and
`crest-meta` to the same admitted set, and only adopts a protected value after
a successful one-shot finish. Cold construction runs the ordinary parser and
replay before finish and protected-record issuance. Disposable local view
repair remains in the ordinary list path. Missing/damaged views rebuild from
the full reader.

A failed proof follows the original complete verification path. Byte continuity,
event validation and materialized reducer authority remain separate. F005 lazy
public history, doctor/shared-submit/write-lock strong SHA and SQLite's prepared
fd full SHA remain required. Timeless projections contain no cached query
freshness: each request evaluates its own `at`, and FTS reconciliation retains
its existing ordering.

## Resource and evidence scope

The existing limits remain: 4096 default/8192 absolute leases, actual RLIMIT
capacity, 8192 guard rules (now including inode watches), 65536 named children,
8 MiB IPC, 16 connections, five-second transactions, 128 MiB heap and 256 MiB RSS
retirement. Separate Crest/Akasha processes add real FD/watch/RSS cost; observed
resources belong to the recorded fixture, not a maximum-capacity guarantee.
Controller process-group ownership, private IO, NODE_OPTIONS, reaping and exact
F006 descriptor retirement are preserved.

Implementation evidence is retained at the platform-container-relative path
`.em-093-096/codex-takeover-20261114/phase-095-crest-continuity/`.
Its report distinguishes protocol fixtures, real list/Recall/FTS behavior,
complete helper/client kernel journals, cold discovery, fallbacks, private
frozen-input latency and unverified obligations. Trace-induced timeout failures
are retained and never counted as warm proofs. Prior 1110 native hash counters
and the older 64-member trace are historical prototype evidence only.

The prior real-default CLI/Hook latency failures remain failures at their
original source/input identity. Real rclone/remote behavior, Mac/Drive, Windows,
non-ext4 providers, production-library enablement and global/native host hook
loading remain unverified. Declaring `EINZBERN_HOST=claude-code` does not prove
Codex native hook loading. Independent final P1/formal acceptance belongs to a
different fresh worker after this candidate is frozen.
