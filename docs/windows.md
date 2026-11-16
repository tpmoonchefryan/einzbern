# Windows support

Use Node 24.16.0 and pnpm 11.3.0 for source development. Git for Windows is
required for repository operations. Run commands from PowerShell in the checkout.

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts --config.offline=false
corepack pnpm run build
corepack pnpm run typecheck
corepack pnpm run format:check
node --test --test-concurrency=1 tests/windows-platform.test.mjs tests/memory-windows.test.mjs
```

Source reads bind a regular file's descriptor to filesystem identity observations
before and after reading. Hardlinks, changed identities and reparse-point
substitution are rejected. Windows builds use an exclusive directory claim with
a private NTFS DACL. Nested operations share the current claim, while independent
writers receive a refusal until its release. Exceptions release a verified claim. An
interrupted process leaves a claim requiring recovery because parent termination
does not establish that every descendant has stopped writing.

The POSIX process-group test controller used by `pnpm test` and full P1 verification
requires additional Windows lifecycle support. The Windows CI job runs the listed
Node test files directly and reports that coverage separately. The full-suite
entry returns `TEST_CONTROLLER_PLATFORM_UNSUPPORTED` before starting its controller.

Runtime relocation uses NTFS junctions, preserving access through the original
device paths without requiring symbolic-link privileges. Relative stored paths
require the device and runtime directories to be on the same volume. Nested
runtime destinations inside the device directory are rejected before mutation.

The Mana Orchestrate installer accepts quoted paths containing spaces and Unicode.
It checks the release digest and rejects Windows device names, alternate data
streams, trailing dots or spaces and case-colliding archive files before unpacking.
The generated distribution pins LF endings so Windows checkouts reproduce the
published files. Both repositories run Windows Server 2022 CI jobs.
