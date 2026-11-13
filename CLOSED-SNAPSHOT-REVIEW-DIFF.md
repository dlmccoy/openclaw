# Closed snapshot: review diff, not a migration

Status: design only. None of the following DDL or pseudocode is registered, executable, or enabled. The objective is to gate **external transcript export**, not ordinary chat delivery. A run reaching `done` or a cold archive is not a closed session. A closed turn is also not a permanently closed session.

## Existing seams and alternatives

- `src/infra/agent-run-terminal-writes.ts` removes settled promises and drains with `Promise.allSettled`, without reporting success. Extend its owner with an occurrence-bound settlement result and an admission seal, or keep it unchanged and create a separate storage-owner receipt. The latter avoids changing current drain callers but requires a complete producer inventory. Unknown/rejected outcomes remain ineligible.
- The same agent database already has a useful precedent: `src/agents/harness/context-engine-turn-outbox.kernel.worker.ts` advances an accepted turn using `readClosedTranscriptTurnInDatabase`; `src/config/sessions/session-accessor.transcript-range.worker.ts` validates matching generation/anchors and a bounded, consistent read. Its semantics are **closed turn**, not closed session, and its stored messages, ownership, retention and deletion semantics cannot be reused without review. Reuse the bounded-reader techniques and worker transaction owner, not the existing table blindly.
- The ordinary delivery queue (`src/infra/delivery-queue-sqlite.ts`) opens the **state** database, whereas `session-accessor.sqlite-lifecycle.ts` opens the **agent** database. An enqueue in that queue is not atomic with an agent-database snapshot. Prefer a separate same-agent-database intent; reuse queue patterns only after verifying ownership and privacy.

## Candidate schema diff for owner review

Illustrative SQLite only; no production migration is included. PostgreSQL parity, migrations, generated types, retention and indexes remain work. The session-to-node generation identity and foreign-key deletion behavior require validation against the actual schema and lifecycle operations.

```diff
+ CREATE TABLE closed_snapshot_generation (
+   session_id TEXT NOT NULL,
+   generation_id TEXT NOT NULL,
+   lifecycle_revision TEXT NOT NULL,
+   state TEXT NOT NULL CHECK (state IN ('open','sealed','revoked')),
+   source_revision INTEGER NOT NULL,
+   PRIMARY KEY (session_id, generation_id)
+ );
+ CREATE TABLE closed_snapshot (
+   snapshot_id TEXT PRIMARY KEY,
+   session_id TEXT NOT NULL,
+   generation_id TEXT NOT NULL,
+   source_revision INTEGER NOT NULL,
+   snapshot_digest TEXT NOT NULL,
+   bounded_payload BLOB NOT NULL,
+   created_at_ms INTEGER NOT NULL,
+   UNIQUE (session_id, generation_id),
+   FOREIGN KEY (session_id, generation_id)
+     REFERENCES closed_snapshot_generation(session_id, generation_id)
+ );
+ CREATE TABLE closed_snapshot_outbox (
+   event_id TEXT PRIMARY KEY,
+   snapshot_id TEXT NOT NULL UNIQUE REFERENCES closed_snapshot(snapshot_id),
+   state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','revoked')),
+   claim_token TEXT,
+   lease_until_ms INTEGER,
+   attempts INTEGER NOT NULL DEFAULT 0,
+   created_at_ms INTEGER NOT NULL,
+   delivered_at_ms INTEGER
+ );
+ CREATE INDEX closed_snapshot_outbox_pending
+   ON closed_snapshot_outbox(state, lease_until_ms);
```

This option duplicates bounded transcript content locally and therefore needs an explicit retention, access, size, deletion and backup review. An immutable generation/revision anchor instead avoids content duplication, but only works if the canonical transcript can be pinned and replayed through compaction, retention, deletion, and crashes. Neither option is authorized for real data merely by this document. Redaction must occur before export or embedding, including metadata and cross-message echoes; redaction is not guaranteed to identify every secret.

## Candidate transaction boundaries

```diff
+ // Outside DB transaction: seal owner admission for exact occurrence; join all
+ // previously accepted producers; reject failed, unknown, or incomplete work.
+ // Worker synchronous transaction: re-read exact agent DB identity, session,
+ // explicit closed state, generation, revision and authorization; reject if stale.
+ // Read the bounded immutable snapshot, then seal generation + write snapshot
+ // and pending outbox intent in that same agent-database transaction.
+ // Abort rolls back all three; the unique generation key makes retries converge.
```

No asynchronous waits inside the storage transaction. Scope requires explicit agent **and** session IDs; unknown, active, resumed, deleted, incognito/unsupported or unverified generations produce no eligible row. Integrate reset (`session-accessor.sqlite-lifecycle.ts`), delete (`session-accessor.sqlite-deletion.ts`), archive/restore (`session-cold-storage.ts`) and resume (`src/agents/subagents/spawn/acp-spawn.ts`) with the same authority and invalidate pending intents before a replacement commits. Audit all append, correction, branch rewrite, imports, maintenance and other producer paths, not just `session-transcript-event.ts`. Do not ship until the host owns and enforces that invariant.

A worker may claim an intent with a lease and opaque fencing token, then send outside the DB transaction; conditional acknowledgement by the same token handles stale claimants. The stable `event_id` must also be honored by the sink: a crash after remote commit and before local acknowledgement otherwise yields at-least-once delivery and potentially duplicate embedding. A host-side check immediately before network I/O cannot prevent a concurrent deletion after the request begins. Strong delete-wins privacy requires a sink-aware revocation/conditional-commit protocol or verified downstream deletion; until agreed, **no external dispatch**. Never represent local revocation as retracting already delivered data.

## Review and activation gates

1. Storage/lifecycle owners choose durable receipt design, prove writer inventory, settlement failure semantics, and SQLite/PostgreSQL transaction topology. Decide copy versus pinned anchor and deletion/backup retention. Security owners approve access scope and sink revocation semantics.
2. Implement behind a default-off invocation boundary; add real worker/DB race tests for live/unknown/deleted, accepted write failure, resume, delete, reset, restore, retry, crash, stale claim and duplicate sink receipt. Preserve native memory. No production feature is exposed by this branch.
3. After review and separate deployment authorization, deploy disabled, run a scoped inventory/dry-run and inspect counts, then explicitly authorize one synthetic closed session. Validate redaction and stable ID, ingest once, query from a later session, and rerun to measure duplicate embedding calls. Evaluate predeclared 7/28-day parity metrics. Only then seek separate historical-backfill authorization, beginning with dry-run counts; never use discovery across all harnesses.
4. Rollback must be one reviewed disable action and verification that no dispatch continues; it cannot undo prior exports or remove imported material. No exact activation or rollback command exists until the feature is implemented and reviewed.
