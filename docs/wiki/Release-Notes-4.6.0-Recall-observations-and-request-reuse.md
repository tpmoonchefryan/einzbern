# Recall observations and request reuse

- Correlate Hook and CLI calls, events, results and execution spans, and report
  source reads, cache reads, CPU time and elapsed time as separate measurements.
- Reuse validated library authority within one Recall request so knowledge
  retrieval does not materialize the same library twice. Keep library identity,
  project isolation, query results and rejection behavior intact.
- Return role navigation for SubagentStart inputs without real task text instead
  of performing a full Recall for an empty task.

[Version directory](Release-Notes-4.6.0.md)

Related modules:

- [Consolidation replay and source verification](Release-Notes-4.6.0-Consolidation-replay-and-source-verification.md)
- [Project artifact directories](Release-Notes-4.6.0-Project-artifact-directories.md)
- [Antigravity host integration](Release-Notes-4.6.0-Antigravity-host-integration.md)
