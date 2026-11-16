# Windows support

Use Windows 10 or later with NTFS and Windows PowerShell 5.1. Source development
uses Node 24.16.0, pnpm 11.3.0, Git for Windows and Python 3 for CI evidence tools.
Run commands from PowerShell in the checkout.

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts --config.offline=false
corepack pnpm run build
corepack pnpm run typecheck
corepack pnpm run format:check
corepack pnpm exec node --test --test-concurrency=1 tests/windows-platform.test.mjs tests/windows-process.test.mjs tests/memory-windows.test.mjs
corepack pnpm test
```

Source reads bind a regular file's descriptor to filesystem identity observations
before and after reading. Hardlinks, changed identities and reparse-point
substitution are rejected. Windows builds use an exclusive directory claim with
a private NTFS DACL. Nested operations share the current claim, while independent
writers receive a refusal until its release. Exceptions release a verified claim.
After interruption, recovery verifies the owner's termination and that its
recorded Job Object is empty or gone. A named kernel mutex serializes recovery.
Claims without job evidence remain available for explicit investigation.

Windows child commands run in a Job Object. The launcher creates the child
suspended, assigns it to the job and resumes it. Normal exit and cancellation
terminate remaining descendants and wait for the job to become empty before
reporting completion. The monitor holds an operating-system handle to its parent
and terminates the job when that parent exits. Closing the monitor's final job
handle also terminates its descendants.

The standard and selectively planned test entries use the Windows job controller.
It preserves the selected roster, memory admission, timeout result, raw output
and file-level diagnostics. The Windows core and Portal test runners default to
at most four concurrent files and leave a logical CPU available on multi-core systems. An
explicit test worker count or the memory admission policy takes precedence.
The full Windows suite has a 60-minute controller
limit, configurable downward with `TCRN_TEST_CONTROLLER_TIMEOUT_MS`. Its POSIX
process-group recovery fixtures run on Linux. Native Job Object and NTFS recovery
fixtures run on Windows. The Python CI observer holds output descriptors until
it has retained and verified the bytes, then removes the captured Windows files.

The historical INC-155 coverage proof runs against the files from its pinned Git
commit. On Windows its coverage checker uses the engine's NTFS file walker and
checks the discovered test names against that commit's Git tree. On Ubuntu it
uses the original POSIX walker. Both jobs verify the same recorded output bytes.

PATH and PATHEXT lookup support native executables and `.cmd` or `.bat` shims.
Batch arguments preserve spaces, Unicode, quotes and shell metacharacters.
Generated Portal `.cmd` launchers use encoded PowerShell arguments and forward
UTF-8 output and exit codes.
Kiro and Antigravity runners send prompts through stdin. Kiro discovery checks
the executable and product metadata in per-user and Program Files installations.

`spawn-guard.mjs register` accepts `--job` with the launcher's `jobName`, or reads
`EINZBERN_WINDOWS_JOB` inside the job. Pass the actual root process ID as `--pgid`.
Windows registrations use the v2 record with `windowsJobName`. Detection reads
kernel job membership and CIM process observations. Existing v1 POSIX records
remain readable. A Windows live check requires a job registration to establish
the lifetime of detached descendants.

Runtime relocation uses NTFS junctions, preserving access through the original
device paths without requiring symbolic-link privileges. Stored paths support
different drive letters and UNC roots. Nested
runtime destinations inside the device directory are rejected before mutation.

Dispatch receipts and knowledge publication files are created with an owner-only
NTFS ACL that also admits SYSTEM and local administrators. The writer checks the
volume and file ID before writing. Runner recovery files inherit their private
runtime directory’s permissions. Atomic replacement retains open readers of the previous file while new
readers see the replacement. Durable directory updates use a Windows directory
handle with write access and `FlushFileBuffers`.

Legacy metadata/body records and artifact records encode their ID separator as
`%3A` when created on Windows. Both operating systems read these portable names.
POSIX systems continue to read existing colon-containing names and reject
ambiguous duplicate names. Migrate a legacy colon-containing library to its
event-stream layout before transferring its files to NTFS.

The Mana Orchestrate installer accepts quoted paths containing spaces and Unicode.
It checks the release digest and rejects Windows device names, alternate data
streams, trailing dots or spaces and case-colliding archive files before unpacking.
The generated distribution pins LF endings so Windows checkouts reproduce the
published files. Both repositories run Windows Server 2022 and Ubuntu 24.04 jobs.
File-symlink tests report a skip when the account lacks Windows symbolic-link
creation privileges. Directory junction tests run with ordinary user permissions.
