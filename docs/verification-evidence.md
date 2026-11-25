# Verification evidence

The same gate engine serves implementation, merge checks and independent INIT acceptance. Run
the first applicable check through the engine to get its exit status, raw output and input digest.
Plan again on the actual target candidate. Normal work and release authority apply to every stage.

## Plan and run

For named project gates use the existing gates-plan and gates-run commands with the project and
work IDs. A project can set each eligible gate's reuse profile with gates-config-set, or propose
the same profile through gates-config-propose. Pass the profile as JSON in --reuse. The existing
gate configuration authority applies. Use null to remove a profile.

For a check scoped to a package or an INIT acceptance brief, both commands accept --checks-from.
With that option supply --workspace, --project, --base and --work-id. gates-run also takes --at.
The file is an ordered JSON array of checks. Each check names a logical check, its actual command
array, optional root relative to the candidate, and its reuse profile.

~~~json
[
  {
    "name": "unit",
    "command": ["corepack", "pnpm", "run", "test:unit"],
    "reuse": {
      "source": ["src/**", "tests/**", "package.json", "pnpm-lock.yaml"],
      "files": ["node_modules/.pnpm/lock.yaml"],
      "environment": ["CI"],
      "tools": ["node"],
      "portable": true
    }
  }
]
~~~

Use the whole source for a check that reads the whole repository. Declare the commands that make
up a suite as separate checks when their input and output boundaries are known. An opaque suite
still counts as one check. An actual check result covers only the assertions that it executed.

The profile's source globs read actual tracked and non-ignored working files under the gate root.
The files array binds exact files, including ignored inputs. A missing file is a distinct observed
state. The optional outputs array binds required files produced by the check. Their bytes must
still be available when a later phase reuses the result. Include environment variables and
executables consumed by the check, such as toolchain, browser, dependency and fixture inputs.
The engine hashes the resolved base, command, declared inputs, launcher and selected tool bytes,
runtime and relevant environment values. Enable portable only after checking that checkout paths
are immaterial. Set gitHistory for checks that depend on the current Git commit or branch.
Use a fresh check when the input boundary cannot be described or the contract requires a fresh
execution. A check that reads EINZBERN_GATE_RUN_PRIOR runs fresh. Earlier entries there include
matching reused checks and their original logs, with sourceRunId naming the producing run. Release
plans retain fresh execution.

The verification list from gates-plan shows reuse or run, the reason, and the source log for a
match. The executor checks again and records the actual disposition. A matching prior success
refers to its existing raw output. A failed, timed-out, changed or unreadable result remains
due. The gate timeout can be set explicitly with --gate-timeout-ms for a known long-running
check. Batch-local records support the independent review. Formal closeout uses the project's
current gate declarations and work coverage, and rechecks receipts before accepting reused
results. A passing check supports the applicable criteria. The validator still judges coverage
and performs the required independent or Owner checks.

## Hand off

Attach the runId from gates-run to the existing work report as an ordinary line
"Gate-Evidence: <runId>". Paths in outputFile are relative to the library's local gate-runs
directory. Codex carries a member's matching receipts in the existing automatic batch return.
Antigravity carries the same run IDs on the Board and in boardDeliverables.gateRunIds.
At INIT acceptance, plan against the frozen candidate with the same check definitions, attach
the applicable evidence and dispatch only the necessary supplement. Keep live host admission
and native-session evidence bound to the host and attempt that produced it.
