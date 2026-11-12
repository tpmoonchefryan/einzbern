# Consolidation replay and source verification

- Reuse validated consolidation replay checkpoints while retaining the original
  source heads, version vectors, authorization and event-chain checks.
- Reduce source-event reads on eligible macOS paths using device-local prior
  verification records, held-file native identity checks and authenticated event
  projections. Preserve complete source verification when eligibility or current
  integrity cannot be proved; other platforms retain the complete reader.
- Share identical authenticated decoded projections within one operation and
  defer unused verification code. Small inputs use complete verification;
  disposable, untrusted cost advice selects a reader without replacing source
  validation. Small-input scheduling costs remain separate from large-input
  gains, and the optimization requires no external credential service.

[Version directory](Release-Notes-4.6.0.md)

Related modules:

- [Recall observations and request reuse](Release-Notes-4.6.0-Recall-observations-and-request-reuse.md)
- [Project artifact directories](Release-Notes-4.6.0-Project-artifact-directories.md)
- [Antigravity host integration](Release-Notes-4.6.0-Antigravity-host-integration.md)
