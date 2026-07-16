# Local-First Storage and Incremental Sync Options

Date: 2026-07-16

## Decision

Use **Dexie (open-source, local-only)** as the browser database and build a small, application-specific pull engine against the existing Worker and D1 materialization. Do not adopt Dexie Cloud.

Keep **RxDB with the free Dexie RxStorage** as the main alternative if we later need a reusable replication protocol, multi-tab leadership, conflict handling, or offline writes to a domain backend. Keep **standalone PGlite** as a SQL-oriented alternative only if complex relational querying becomes more important than startup size and IndexedDB efficiency.

The other reviewed products either are not durable storage engines by themselves or would require replacing the existing Worker and D1 topology with another database or sync service. D1 remains a bounded cloud materialization and cross-device convergence point; Dexie becomes the browser's durable read model.

This recommendation is intentionally specific to an application-owned protocol: GitHub Atom is ingested automatically into D1, every available increment is synchronized into Dexie, and user filters and the clear watermark converge across devices through a durable local outbox. The authoritative protocol is specified in [Local-First Incremental Sync Design](./local-first-sync-design.md); demand-driven sketches below are superseded research background.

## Target constraints

- React 19 browser SPA.
- IndexedDB-backed durable local data.
- Domain records are read and queried locally; filters remain useful offline.
- GitHub Atom and Following data continue to be refreshed automatically by the Worker Cron and materialized in bounded D1 tables.
- D1-to-browser transfer synchronizes the full bounded retained window and every later increment; filters remain entirely local projections over raw activity.
- D1 is the cross-device convergence point for user filters and the clear watermark, but Dexie is the only browser read path.
- A successful local transaction must commit both fetched records and the cursor/coverage metadata that proves what is present.
- GitHub following is an authoritative set reconciliation problem; activity is primarily append-only, deduplicated incremental ingestion; filters are local user-owned data.

## Shortlist

| Candidate                     | Durable browser store                      | Reactive React use                            | Custom GitHub pull                       | Extra domain backend            | Assessment                                            |
| ----------------------------- | ------------------------------------------ | --------------------------------------------- | ---------------------------------------- | ------------------------------- | ----------------------------------------------------- |
| **Dexie OSS**                 | IndexedDB                                  | `liveQuery` / `useLiveQuery`                  | Straightforward, application-owned       | No                              | **Recommended**                                       |
| **RxDB + Dexie RxStorage**    | IndexedDB                                  | Observable collections and React integrations | Built-in pull replication can be adapted | No specialized backend required | **Strong alternative**                                |
| **PGlite (without Electric)** | PostgreSQL/WASM over IndexedDB VFS         | Live-query extension                          | Application-owned                        | No                              | **SQL-first alternative**                             |
| Legend-State                  | IndexedDB persistence for observable state | Native reactive state                         | Custom sync and CRUD helpers             | No                              | Useful for small state, not the primary feed database |
| TanStack DB                   | Depends on a collection adapter            | Excellent reactive queries                    | Depends on adapter                       | Depends on adapter              | Optional query layer, not the persistence decision    |

## Candidate analysis

### Dexie: recommended

Dexie is a thin database layer over browser IndexedDB, with explicit schema versions and indexed tables ([Dexie API](https://dexie.org/docs/Dexie/Dexie), [schema versions](https://dexie.org/docs/Dexie/Dexie.version%28%29)). It supports versioned data migrations ([`Version.upgrade()`](https://dexie.org/docs/Version/Version.upgrade%28%29)) and atomic multi-table read/write transactions ([`Dexie.transaction()`](https://dexie.org/docs/Dexie/Dexie.transaction%28%29)). Its live-query mechanism observes the IndexedDB ranges actually queried and has a React hook, including notification of compatible mutations from other tabs and workers ([`liveQuery`](https://dexie.org/docs/liveQuery%28%29)). The project is Apache-2.0 licensed ([license](https://github.com/dexie/Dexie.js/blob/master/LICENSE)).

Why it fits:

- The storage model maps directly to the entities, compound indexes, checkpoints, and coverage ranges this application needs.
- A transaction can atomically write activity rows and advance the matching cursor/coverage marker. A crash cannot leave a cursor claiming data that was not committed.
- The application owns demand planning and GitHub-specific reconciliation instead of adapting a general two-way replication protocol.
- It introduces no additional server database or synchronization service.

What it does not provide is equally important: Dexie does not define GitHub cursors, tombstones, completeness, retries, or reconciliation. Those are application logic. Dexie Cloud is a separate synchronization product; this recommendation is for the local open-source database only ([Dexie overview](https://dexie.org/)).

IndexedDB storage is normally best-effort, so the application should request persistent storage when appropriate and surface quota/eviction recovery behavior ([Dexie StorageManager guidance](https://dexie.org/docs/StorageManager)).

### RxDB: strongest batteries-included alternative

RxDB can use its free Dexie RxStorage to persist browser collections in IndexedDB ([Dexie RxStorage](https://rxdb.info/rx-storage-dexie.html)). Its replication protocol supports an arbitrary backend through a pull handler that exchanges document batches and checkpoints; push is optional, and a pull stream can add realtime updates ([replication protocol](https://rxdb.info/replication.html)). It also supplies retry behavior, multi-tab coordination, and conflict machinery.

The protocol imposes useful but real constraints. Checkpoints must define a deterministic order, and deletions need tombstone documents instead of disappearing physically ([replication protocol](https://rxdb.info/replication.html)). Collections use JSON schemas with explicit versions, indexes, and migration strategies ([RxSchema](https://rxdb.info/rx-schema.html)).

Why it may fit:

- A pull-only replication handler can talk to the Worker without requiring an RxDB-specific server.
- It provides more reusable synchronization and multi-tab behavior than a custom Dexie layer.
- It becomes attractive if local mutations later synchronize to a real domain backend.

Why it is not the default:

- GitHub following is a complete-set reconciliation, while activity demand is scoped by actor/time/viewport. These semantics still need custom code around a generic document replication loop.
- The free IndexedDB path is the Dexie storage adapter. RxDB's own documentation positions it for side projects/prototypes and recommends paid premium storage for professional performance and bundle-size needs ([Dexie RxStorage](https://rxdb.info/rx-storage-dexie.html)).
- Schemas, RxDB documents, replication checkpoints, tombstones, and conflict machinery add weight to a mostly read-only upstream cache.

### PGlite: SQL-first alternative, without Electric

PGlite runs PostgreSQL in the browser through WebAssembly and can persist through an `idb://` virtual filesystem ([filesystems](https://pglite.dev/docs/filesystems)). It has live and incremental query APIs ([live queries](https://pglite.dev/docs/live-queries)) and an official worker pattern for sharing the single database connection across tabs ([multi-tab worker](https://pglite.dev/docs/multi-tab-worker)). PGlite is dual-licensed under Apache-2.0 and the PostgreSQL License ([license](https://github.com/electric-sql/pglite/blob/main/LICENSE)).

It is viable if the feed evolves into a genuinely relational analytics workload. However, the documented IndexedDB filesystem loads database files into memory at startup and flushes entire changed table/index files as blobs after queries ([filesystems](https://pglite.dev/docs/filesystems)). Minor-version upgrades may require dumping with the old version and importing into a new instance ([upgrade guide](https://pglite.dev/docs/upgrade)). Those costs are a poor default for a feed that benefits from small indexed writes and quick startup.

Electric is a separate decision. Its current sync product is a read-path synchronization engine for Postgres, exposing subsets through Shapes ([Electric sync overview](https://electric-sql.com/docs/intro)). Adding authoritative Postgres plus Electric would replace the existing Worker and D1 topology without removing the need for application-specific Atom, Following snapshot, retention-floor, and filter-outbox semantics. Therefore, only standalone PGlite belongs on the shortlist.

### TanStack DB: optional reactive query layer

TanStack DB provides normalized collections and reactive local queries, but persistence and synchronization come from the chosen collection implementation ([overview](https://tanstack.com/db/latest/docs/overview)). Its local-only collection is memory-only ([LocalOnlyCollection](https://tanstack.com/db/latest/docs/collections/local-only-collection)), and its localStorage collection is intended for small preferences and UI state rather than a feed database ([LocalStorageCollection](https://tanstack.com/db/latest/docs/collections/local-storage-collection)).

The official RxDB integration mirrors durable RxDB data into an in-memory TanStack collection, so records exist both on disk and in memory ([RxDB collection](https://tanstack.com/db/latest/docs/collections/rxdb-collection)). The current Dexie integration is listed as community-maintained rather than official ([community resources](https://tanstack.com/db/latest/docs/community/resources)).

TanStack DB may later improve cross-collection UI queries, but it should not determine storage now. The application already has a React query layer, and adding another in-memory normalized layer has a cost.

### Legend-State: useful state/sync primitives, not the primary database

Legend-State supports local-first observable state, retrying pending changes, lazy synchronization on first access, and custom sync implementations. Its IndexedDB plugin persists dictionaries as rows, and its CRUD sync helper supports `last-sync` changes, update timestamps, and soft-delete fields ([persist and sync](https://legendapp.com/open-source/state/v3/sync/persist-sync/), [CRUD sync](https://legendapp.com/open-source/state/v3/sync/crud/)).

These are attractive primitives for settings or compact sync state. They are not a replacement for a database with compound indexes, range scans, transactional writes across entity/checkpoint/coverage tables, and explicit large-feed query planning. Legend-State is therefore not recommended as the primary store.

## Eliminated options

### Electric

Electric synchronizes subsets of an authoritative Postgres database through Shapes ([Electric sync overview](https://electric-sql.com/docs/intro)). The proposed architecture already has GitHub as the upstream and D1 as a bounded materialization, so Electric would add an unnecessary authoritative Postgres and sync service. Standalone PGlite was assessed separately above.

### Zero and Replicache

Zero requires upstream Postgres and a `zero-cache` service; self-hosting also includes an API server, and its Postgres integration depends on logical replication ([zero-cache configuration](https://zero.rocicorp.dev/docs/zero-cache-config), [self-hosting](https://zero.rocicorp.dev/docs/self-host), [connecting Postgres](https://zero.rocicorp.dev/docs/connecting-to-postgres)). This would replace the current Worker and D1 deployment model.

Replicache is not a good new foundation. Its v10 release moved from BSL to closed source and requires a license key. The same release notes describe its newer storage behavior as "Local Acceleration," including limitations for synchronization between offline tabs, rather than the full offline-first model required here ([Replicache releases](https://github.com/rocicorp/replicache/releases)).

### PowerSync

PowerSync provides a strong local SQLite experience, but its architecture replicates an upstream database through the PowerSync service, which stores bucket operation history and streams it to clients ([PowerSync service architecture](https://docs.powersync.com/architecture/powersync-service)). Client writes are uploaded through the application's backend ([client-side backend integration](https://docs.powersync.com/configuration/app-backend/client-side-integration)). That server database and sync-service topology is outside the target architecture.

### Triplit

Triplit combines an IndexedDB client database with a durable server database and WebSocket synchronization. Its official quick start starts a sync server and configures a server URL/token; the repository is AGPL-3.0 ([official repository](https://github.com/aspen-cloud/triplit)). New Triplit Cloud sign-ups are currently unavailable, with self-hosting recommended ([dashboard notice](https://www.triplit.dev/dashboard)). Running its domain sync server merely to cache GitHub data would be architectural overhead.

### TinyBase

TinyBase can persist a regular Store to IndexedDB ([IndexedDB persister](https://tinybase.org/api/persister-indexed-db/functions/creation/createindexeddbpersister/)) and synchronizes a MergeableStore over WebSockets, BroadcastChannel, or custom transports ([synchronization guide](https://tinybase.org/guides/synchronization/)). However, the official compatibility table states that its IndexedDB persister cannot persist MergeableStore synchronization metadata ([MergeableStore persistence](https://tinybase.org/guides/synchronization/using-a-mergeablestore/)). That makes it a poor fit for durable IndexedDB synchronization, even before considering feed indexes and range queries.

## Initial data and sync sketch

This section predates the decision to retain Cron and D1 ingestion. It records the reasoning that led to the Dexie choice, but [Local-First Incremental Sync Design](./local-first-sync-design.md) supersedes it wherever the two differ.

### Local tables

The exact names can change, but the responsibilities should remain separate:

| Table                                     | Purpose                                                     | Important keys/indexes                                                            |
| ----------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `githubUsers`                             | Stable actor identity and profile summary                   | GitHub numeric user ID; unique login as a mutable lookup                          |
| `followingSnapshots` / `followingMembers` | Last complete authoritative following set                   | snapshot ID; user ID                                                              |
| `activities`                              | Compact feed rows used for ordering and filtering           | event ID; `[actorId+publishedAt+id]`; `[publishedAt+id]`; `[type+publishedAt+id]` |
| `activityDetails`                         | Heavy payload fetched only when opened                      | event ID                                                                          |
| `filters`                                 | Local user-owned filter definitions                         | filter ID                                                                         |
| `syncCursors`                             | Upstream cursor/ETag and retry state per resource           | resource key                                                                      |
| `coverageSegments`                        | Evidence that an actor/time/page range is complete          | resource, actor, range boundaries                                                 |
| `syncRuns`                                | Optional diagnostics, failures, and rate-limit observations | run ID, started time                                                              |

Use GitHub numeric IDs as identity whenever available; logins are mutable. Keep raw activity data independent from filter membership so changing a filter works fully offline.

### Demand-driven pull flow

1. The UI asks for a local query such as a feed window, an actor slice, or one activity detail.
2. The local query returns immediately, together with whether its requested range is covered.
3. A demand planner coalesces identical requests and subtracts already-covered ranges.
4. The Worker returns only the missing range from the bounded D1 materialization, together with revision and retention metadata.
5. One Dexie transaction upserts normalized records, reconciles removals where the response is authoritative, and advances the cursor/coverage marker.
6. `useLiveQuery` updates visible React results after commit. Failures leave existing local data readable and do not advance coverage.

Deduplicate concurrent pulls by a stable resource key such as `activity:<actorId>:<range>`. Apply bounded retries with jitter, but honor GitHub rate-limit reset information. Use abort signals when the last consumer of an uncovered request disappears.

### Resource-specific rules

**Following:** fetch a complete authoritative snapshot, then reconcile additions and removals in one transaction. A partial page must never be interpreted as a deletion. Store a snapshot generation or completeness flag before exposing removals.

**Activity:** ingest append-only pages, deduplicate by GitHub event ID, and use a deterministic ordering key such as `(publishedAt, id)`. Store upstream ETags or cursors per actor/resource when available. Late or edited events should be upserts, not ignored because their timestamp is old.

**Details:** keep large payloads separate from feed summaries and fetch them only when opened. Record detail freshness independently from feed-window coverage.

**Filters:** evaluate against local raw activities. Filter edits commit locally together with an outbox mutation and never wait for the network. Cross-device convergence uses mutation IDs, compare-and-swap versions, server acknowledgements, replay, and delete tombstones.

### Correctness invariants

- Never advance a cursor or mark coverage complete outside the same transaction that commits the corresponding records.
- Coverage describes what was successfully fetched, not merely what was requested.
- Only an explicitly complete authoritative response may delete or deactivate missing members.
- Every pull is idempotent: replaying a page produces the same records and checkpoint.
- Local queries do not block on the network; freshness and coverage are separate UI states from data availability.
- Schema upgrades are forward-only and tested with representative existing databases.
- Quota pressure stops new pulls and surfaces a storage-full state. The application never silently evicts local activity, filters, outbox entries, or sync metadata.

## Suggested validation spike

Before committing to the full migration, build a narrow Dexie prototype that proves:

1. A compound-index feed query remains fast with a representative activity volume.
2. Writing one page and its coverage marker is atomic under forced interruption.
3. Two tabs coalesce or safely race the same pull without corrupting cursors.
4. A complete following refresh reconciles removals without transient false deletions.
5. Persistent-storage denial and quota exhaustion preserve filters and recover cleanly.
6. Opening an activity fetches only its missing detail and updates the view reactively.

Compare the same pull contract with RxDB only if the prototype reveals that custom multi-tab/retry/checkpoint logic is becoming a substantial subsystem. Compare PGlite only if required local SQL queries cannot be expressed efficiently with the planned IndexedDB indexes.

## Research method

The candidate list started from [awesome-local-first](https://github.com/alexanderop/awesome-local-first), but every material assessment above was checked against the candidate's official documentation, source repository, license, or release notes. The awesome list was used for discovery, not as evidence for the recommendation.
