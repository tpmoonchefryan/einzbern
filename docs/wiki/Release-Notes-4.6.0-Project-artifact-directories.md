# Project artifact directories

- Accept project-scoped absolute artifact directories on another mounted volume.
  Save device-local location bindings and resolve them in fresh processes for
  generation and readback, preserving other projects' directories.
- Report missing bindings, unavailable volumes and permission failures without
  silently redirecting output. Preserve shared artifact history when a project
  is registered, and verify shared and project-scoped artifacts together.

[Version directory](Release-Notes-4.6.0.md)

Related modules:

- [Recall observations and request reuse](Release-Notes-4.6.0-Recall-observations-and-request-reuse.md)
- [Consolidation replay and source verification](Release-Notes-4.6.0-Consolidation-replay-and-source-verification.md)
- [Antigravity host integration](Release-Notes-4.6.0-Antigravity-host-integration.md)
