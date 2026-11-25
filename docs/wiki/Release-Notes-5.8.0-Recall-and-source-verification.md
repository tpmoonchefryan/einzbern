# Recall and source verification

- Retain full source verification whenever an input has changed or cannot be verified. Reuse equivalent materialized and Crest projection results when their source and receipt still match, and rebuild or fall back when they diverge.
- Treat a Darwin File Provider placeholder as unavailable before the general source reader opens it. Keep the full-read path for materialized sources and report native evidence only for the environments actually observed.

[Version directory](Release-Notes-5.8.0.md)

Related modules

- [Work planning and acceptance](Release-Notes-5.8.0-Work-planning-and-acceptance.md)
- [Codex coordination and Pack dispatch](Release-Notes-5.8.0-Codex-coordination-and-Pack-dispatch.md)
- [Command diagnostics and Skill examples](Release-Notes-5.8.0-Command-diagnostics-and-Skill-examples.md)
