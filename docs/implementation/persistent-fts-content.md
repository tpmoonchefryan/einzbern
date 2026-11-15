# Persistent FTS content

The rebuildable Recall cache uses internal format `record-clause-fts-v18`.
The public Recall contract, FTS5 `unicode61` tokenizer, indexed values and field
weights are unchanged. In-memory indexes retain the plain content table.

Persistent indexes store `rowId` and one compressed `payload` in
`recall_fts_payload`. `recall_fts_content` is an external-content view exposing
the original nine columns through the connection-local `recall_fts_text` UDF.
`recall_prose_view` retains its original `COALESCE` expressions, including the
difference between NULL and empty prose fields. Index insertions use the same
original text; incremental deletions and FTS integrity checks consume that text
through the views. BM25 document lengths and scores remain SQLite's values.

Each payload contains four exact UTF-8 bytes `EFT1`, an eight-byte little-endian
IEEE-754 integer giving the serialized byte length, and a complete zlib stream
of a V8-serialized array. Array order is title, body, tags, expansions,
externalKey, proseTitle, proseBody, proseTags, proseExpansions. The first five
values must be strings; the last four must be strings or NULL. The decoder
checks the header, safe positive length within Node's buffer capacity, zlib
checksum, complete consumed input, exact output length, array arity and types.
Inflation is bounded by the declared row length; decoded data lives only for
the SQL call. There is no decoded-row or corpus memoization and no additional
document size policy. The pinned Node 24.16 runtime supports SQLite UDFs and
zlib's `info`/`maxOutputLength` options without additional dependencies.

Every persistent create, restored reader, writable copy and published reader
registers the UDF. Unsupported registration closes the connection and uses the
existing complete in-memory fallback. Old format bindings, missing artifacts,
corruption, truncation, busy locks and query errors retain the existing
rebuild/fallback behavior. A v17 cache is rebuilt, never interpreted as v18.

Compression checksums provide no source or reducer authority. Every persisted
SQLite consume still verifies complete held/prepared-fd SHA-256, EOF and length
against the protected projection and checks the current named file identity.
Mapped and same-size/mtime edits remain detectable. Source attestors, complete
authenticated history, lazy events, Crest proofs and strong write paths retain
their existing contracts.

`tests/init095-fts-storage.test.mjs` compares real persistent SQL text and BM25
against the plain index, exercises integrity checking, fresh-process reopening,
incremental changes, malformed frames, nullable prose and a legal large row.
`tests/init095-cache.test.mjs` covers cross-process expiry/delivery, busy and
truncated artifacts, and complete/prepared-fd mapped-write verification.
