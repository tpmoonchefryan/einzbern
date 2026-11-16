# Local history and index reads

- Reuse verified history segments and validated local projections during CLI and hook reads. Compressed external-content FTS storage reduces local index size. Existing indexes can be rebuilt and the full source reader remains available.
- An opt-in Linux source attestor can reuse verified local source reads while its native lease remains valid. A missing helper, unsupported filesystem or unavailable proof selects full verification.

[Version directory](Release-Notes-5.0.0.md)

Related modules

- [Work lists and Atelier](Release-Notes-5.0.0-Work-lists-and-Atelier.md)
- [Knowledge and decision retrieval](Release-Notes-5.0.0-Knowledge-and-decision-retrieval.md)
- [Host navigation and portable gates](Release-Notes-5.0.0-Host-navigation-and-portable-gates.md)
