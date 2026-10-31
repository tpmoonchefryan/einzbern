# 4.0.0 — Device memory admission

- Add an opt-in device memory policy alongside existing heavy-run and agent caps.
  Admit managed work from current process and platform observations, a configured
  reserve and budget, and per-command workload estimates. Missing or uncertain
  required observations refuse dependent work; an unset policy preserves existing
  execution and installation does not enable it.
- Share reservations within the existing local heavy-run resource domain, retain
  process identity and unresolved descendants, and subdivide nested reservations.
  Translate admitted workers to actual Node test concurrency and recheck pressure
  before new work starts without weakening test selection or killing active work.
- Include only the policy in device-preference configuration backups. Exclude
  observations, leases and run receipts; re-evaluate destination memory after
  restore. Sampled process-tree RSS remains an observation, not exact physical
  accounting or an operating-system memory limit.

[4.0.0 module directory](Release-Notes-4.0.0.md) · [All releases](Release-Notes.md)
