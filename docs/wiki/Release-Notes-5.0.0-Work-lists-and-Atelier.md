# Work lists and Atelier

- Ordinary `work-list` calls now return compact records and the effective filter scope. Clients that read `records[].fields` from an unfiltered or filtered list should add `--full true` to keep the complete goal, acceptance and body. Use `work-show` for a single full record. Search keeps its bounded excerpts by default.
- Atelier can filter work by project, show the ancestors of matching records, and release active or expired work leases. Work, minutes and batch mutations return local readback receipts. Knowledge creation checks its committed event and body.

[Version directory](Release-Notes-5.0.0.md)

Related modules

- [Knowledge and decision retrieval](Release-Notes-5.0.0-Knowledge-and-decision-retrieval.md)
- [Local history and index reads](Release-Notes-5.0.0-Local-history-and-index-reads.md)
- [Host navigation and portable gates](Release-Notes-5.0.0-Host-navigation-and-portable-gates.md)
