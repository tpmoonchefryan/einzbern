# Optional continuous source proof candidate

The default reader retains full SHA-256 and event/segment validation. This
candidate adds an explicit, local Linux capability pilot for one selected root.
It does not change Akasha, source permissions, write locks, doctor, shared-submit,
actors, supersession or write/readback semantics. It is not an installation,
release, production enablement or independent acceptance result.

Build the ordinary engine first, then explicitly build the optional bridge:

```sh
pnpm build
node scripts/build-source-lease.mjs native/linux-source-lease.c dist/native/linux-source-lease.node
```

The builder resolves `process.execPath` and that installation's `../include/node`
with `node_api.h`. It uses the existing C compiler, N-API 8 and Node 24; it never
downloads headers, invokes an installer or substitutes another Node's includes.
No device absolute path is embedded. An unavailable compiler/header/module is a
capability miss. The normal build does not require a compiler. The portable
release contains the C source, builder and bundled helper, without a native
binary or install hook. For an authorized installed pilot, explicitly build to
an external disposable device directory; do not modify the installed tree.

Only an explicit `EINZBERN_SOURCE_ATTESTOR_ROOT` equal to the resolved library
root selects the pilot. `EINZBERN_SOURCE_LEASE_MODULE` locates its optional local
binary. These select a capability, never weaker verification. The helper is
started on demand with the same Node executable. There is no autostart or system
service, and no Python dependency. Other platforms/filesystems retain full SHA.
The native candidate admits local ext4 with the required statx fields and actual
successful read leases; it makes no claim for Drive, rclone remote semantics,
network filesystems, macOS or Windows.

The helper uses an authenticated filesystem Unix stream socket. The canonical
absolute socket path is checked for ownership, type and 0600 permissions in a
real 0700 owner-private directory before connecting. It must fit the Linux
108-byte sockaddr_un capacity including its terminator. There is no abstract,
TCP, localhost, DNS, TLS or UDP fallback. Unusable or legacy endpoints retain
the ordinary full reader. Its random secret, epoch and endpoint are in a 0600
descriptor in that checked device directory,
outside source/runtime/derived cache writer roots, using the existing device
trust boundary. An on-disk descriptor is only a rendezvous: a fresh challenge,
HMAC, message number, socket-local single-use token, complete request digest,
native generation and fd incarnations must all match. Disk history, cache
checksums and process IDs never prove a live lease. A dead descriptor is retired
only after its process is confirmed gone; the failed request still reads fully.
Retirement also admits a genuinely absent epoch socket, after rechecking the
private parent and the descriptor's original file identity and exact contents.
An invalid/replaced descriptor, unsafe endpoint or unknown/EPERM PID is retained.
The next fresh client may start a new epoch and must perform initial SHA again.

Under the ordinary test controller, the helper inherits its existing owned
process group, preserves the child-policy preload and sends startup diagnostics
through private pipes to its log. It cannot escape the controller's reaper or
retain controller output descriptors. Outside that controller, the existing
on-demand detached lifecycle is retained. No detached-child exemption is added.

Each initial digest comes from the exact O_RDONLY fd that successfully acquired
F_SETLEASE/F_RDLCK. Native checks compare held statx with the current object,
resolve every ancestor with openat/O_NOFOLLOW and require a regular nlink=1 file.
The same process holds those fds across clients. Reacquisition always computes
SHA-256 again; a new process has a new epoch and no content authority. A retained
healthy fd can survive unrelated metadata/tail changes, but every new begin
binds the full source set, declared lengths/digests, root/library/index/provenance,
heads/vectors, device, engine/runtime/helper/native identity and schema.

Metadata files also receive read leases and same-fd hashes. Before any adoption,
the normal reader re-enumerates and validates metadata inside the guarded
transaction; an incomplete preparation cannot authorize the full set. Inotify
watches the current parent directories and root ancestry before these checks.
Any mutation event, removed watch, queue overflow or error permanently dirties
that transaction. Native name/fd and F_GETLEASE checks are bracketed by clean
directory-guard reads at begin and finish; the final guard/generation check is
the adoption boundary. It attests the completed read at that boundary, not an
unbounded guarantee after return. Unrelated ancestor activity can cause a
conservative miss. Privileged bypasses of VFS and writers of device config are
outside this existing local trust boundary.

Linux targets lease-break signals at the dedicated main native thread. The
SA_SIGINFO handler only stores sig_atomic_t invalidation/generation and uses
async-signal-safe fcntl to unlock the affected fd, in that order. SIGIO overflow
fallback invalidates all leases. No JS callback, allocation, logging or mutex is
used in the handler. F_GETLEASE also detects a pending/forced break, and a dirty
entry is never made valid again. A stalled/stopped/killed helper cannot restore
old authority after the kernel releases a lease. A conflicting nonblocking
writer can receive EAGAIN; normal writer release timing requires measurement.

The attestor proves bytes only. Protected event projections, event-chain/head/
vector checks and independently recorded reducer coverage still authorize all
event/state reuse. The expected digest alone never issues event or replay proof.
An independently authenticated protected materialized state is also reducer
authority when the separate legacy replay receipt is absent. All applicable
reducer authorities must be unavailable before a full reducer replay is needed.
Before returning that state, its complete compressed history is independently
authenticated at the same binding and retained in memory. Decoding remains lazy;
cache loss or a later head cannot invalidate or replace the returned history.
Missing or damaged history dependencies reject adoption and rebuild normally.
Any finish loss discards adoption and reruns the ordinary full reader. Public
event readers and reads under a write lock keep their original full behavior.

The default budget is 4096 file leases, capped by RLIMIT_NOFILE and an absolute
8192 resource bound. `EINZBERN_SOURCE_ATTESTOR_FDS` can choose a smaller/larger
budget within that bound; there is no 128-segment discontinuity. Whole requests
over budget use full SHA. IPC is bounded at 8 MiB, sixteen connections and five
seconds per transaction. The helper has a 128 MiB V8 heap limit, a 256 MiB RSS
stop boundary, and a 60-second idle exit. Idle, explicit stop and normal signals
close all owned fds/guards/socket and remove the exact owned descriptor. Kernel process
exit releases leases on crash. The private `controlSourceAttestor(root, home,
"status" | "stop")` API inspects/stops this helper without starting a new one.

Tests compile only a disposable C actor for real writer/mmap/fork behavior.
The independent read observer journals actual source read calls in both client
and helper processes. Product counters include helper initial source hashes,
separately from cache bytes and reducer replays. Fixture measurements are not
current production-library or remote synchronization measurements.
