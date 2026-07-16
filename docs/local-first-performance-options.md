# Local-First Performance Options

## Question

Could a library from [awesome-local-first](https://github.com/alexanderop/awesome-local-first) materially outperform Better GitHub Feed's current Dexie + custom Cloudflare D1 incremental-sync architecture?

The workload considered here is a React web app with roughly 5,000 retained Atom Activity records, local indexed filtering, atomic page-and-checkpoint commits, and multi-tab coordination. D1 remains the preferred cloud database.

## Executive recommendation

**Keep Dexie and the custom sync protocol for now. Optimize the bootstrap transport before replacing the local database.**

The captured cold sync transferred about 1.7 MB through roughly 20 sequential `getActivityHistoryPage` requests, each taking around 1.4–3 seconds. Replacing IndexedDB with SQLite, OPFS, RxDB, or PGlite cannot remove those network round trips. At this dataset size, the highest-value change is a larger or streaming snapshot response that preserves a fixed `throughSeq`, with transactional local commits at chunk boundaries.

Recommended order:

1. Add timing around fetch, response decoding, and each Dexie transaction to prove the split between network and local work.
2. Replace continuation-dependent 250-row bootstrap requests with one streamed response, or a much larger bootstrap page. Cloudflare Workers do not enforce a response-body limit and recommend streaming large bodies to stay within the 128 MB isolate limit ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).
3. Keep keyset delta pages for later incremental syncs, where result sets are small.
4. Only prototype an OPFS/SQLite engine if local query or commit traces remain materially slow after the network change. Test it in Chrome, Firefox, Safari, Android browsers, and multiple tabs before considering migration.

## Network/protocol performance versus local performance

### Network/protocol path

The initial sync is serial because every opaque history cursor depends on the previous page. Twenty requests therefore pay end-user-to-Worker latency, authentication/RPC overhead, Worker-to-D1 work, serialization, and response transfer twenty times. Smart Placement can reduce Worker-to-database latency, but Cloudflare describes it as placing execution closer to upstream infrastructure; it does not eliminate browser-to-Worker round trips ([Placement](https://developers.cloudflare.com/workers/configuration/placement/)). D1 read replication can reduce query latency for nearby replicas, but likewise does not change the number of HTTP requests ([D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)).

A storage/sync framework only improves this path if it also replaces the protocol and backend. Electric and PowerSync do that, but both require a supported source-database replication topology rather than D1. The infrastructure migration is disproportionate for an append-mostly, single-reader feed.

### Local storage/query path

The current schema already uses compound IndexedDB indexes matching publication order, actor filters, type filters, and actor-plus-type filters. Dexie compound indexes provide efficient B-tree lookup and ordered range scans when the leading fields match the query ([Dexie compound indexes](https://dexie.org/docs/Compound-Index)). `bulkPut()` is explicitly optimized over calling `put()` in a loop and can be enclosed in a transaction for atomicity ([Dexie bulkPut](https://dexie.org/docs/Table/Table.bulkPut%28%29)). Dexie also propagates observed mutations across tabs and workers ([Dexie liveQuery](https://dexie.org/docs/liveQuery%28%29)).

SQLite can make arbitrary combinations, joins, aggregation, and full-text search easier, and OPFS can improve raw read throughput. Those advantages matter more for hundreds of thousands of rows or complex ad-hoc SQL than for an indexed, windowed feed of about 5,000 records. SQLite/WASM also adds initialization, WASM-to-JavaScript transfer, worker messaging, VFS, and multi-tab ownership costs.

## Options

| Option                                                            | Expected network impact                                                                                                           | Expected local impact for this workload                                                                                                                          | Multi-tab / compatibility                                                                                                                                         | License and backend fit                                                                       | Migration cost | Verdict                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- |
| **Current Dexie + custom D1 sync**                                | None by itself; protocol is fully controllable and can be streamed without changing D1                                            | Already well matched to indexed feed windows and atomic bulk transactions                                                                                        | IndexedDB is the portable browser baseline; Dexie broadcasts mutations across contexts                                                                            | Dexie is Apache-2.0; keeps D1 and the existing Worker                                         | Low            | **Recommended**                                                      |
| **RxDB + Dexie/IndexedDB storage**                                | None unless the replication protocol is also rewritten                                                                            | Usually neutral or slower than direct Dexie because it adds schema, observable, replication, and document layers over the same storage                           | Built-in multi-instance features                                                                                                                                  | Core and Dexie storage are Apache-2.0; optimized IndexedDB is Premium                         | High           | Adds capabilities, not a credible speedup                            |
| **RxDB OPFS storage**                                             | None                                                                                                                              | RxDB reports up to 2x insert and up to 4x read improvements over IndexedDB in its own storage tests, but worker messaging can outweigh gains for bulk operations | Worker setup required; browser OPFS behavior must be tested                                                                                                       | OPFS engine is Premium, currently from $99/month                                              | High           | Prototype only if tracing proves local I/O is dominant               |
| **PGlite**                                                        | None with the current D1 protocol; Electric sync would change the backend topology                                                | Full Postgres SQL and incremental live queries are attractive for complex projections, but startup/WASM/VFS overhead is high for 5k rows                         | Single connection; official multi-tab worker elects one leader. PGlite currently recommends IndexedDB persistence because its OPFS VFS is not supported by Safari | Apache-2.0; can keep custom sync, but then replaces only the local engine                     | Very high      | Better query expressiveness, not justified by measured bottleneck    |
| **LiveStore**                                                     | Its sync engine could replace the protocol, but requires an event-sourced backend adapter and a new data model                    | Reactive SQLite/OPFS can produce synchronous reactive state after worker processing                                                                              | Requires OPFS, SharedWorker, Web Locks, and WASM; official docs say the web adapter does not work on Android browsers lacking SharedWorker                        | Apache-2.0; custom sync is supported, including Cloudflare-oriented packages                  | Very high      | Poor browser-compatibility fit and a full architecture rewrite       |
| **Electric**                                                      | Potentially strong initial/continuous shape streaming, but only after moving authoritative replicated data to Postgres            | Typically paired with a local store such as PGlite; local SQL is capable                                                                                         | Framework-managed shape stream                                                                                                                                    | Apache-2.0; Electric sync is built around Postgres logical replication, not D1                | Extreme        | Reject unless the project independently moves from D1 to Postgres    |
| **PowerSync**                                                     | Purpose-built continuous sync can outperform a handwritten paged protocol, but requires its service and supported source database | Embedded SQLite with IndexedDB or OPFS; official Web SDK says OPFS generally improves performance                                                                | Multiple Web VFS choices; multi-tab behavior depends on VFS/worker configuration                                                                                  | Service can be self-hosted, but source must be Postgres, MongoDB, MySQL, or SQL Server—not D1 | Extreme        | Reject while D1 remains a constraint                                 |
| **Direct SQLite/WASM + OPFS (wa-sqlite or official SQLite WASM)** | None                                                                                                                              | Potentially the fastest complex local SQL/read path, but the app must implement reactivity, migrations, worker RPC, and row mapping                              | Official SQLite OPFS permits only one open handle to a database; a second tab can hit locking errors unless a coordinating VFS/worker architecture is added       | Open-source and backend-independent                                                           | Very high      | Plausible future engine, but only behind a measured local bottleneck |

## Evidence by candidate

### Dexie

Dexie is a minimal IndexedDB wrapper and describes IndexedDB as the portable database across browser engines ([Dexie repository](https://github.com/dexie/Dexie.js)). The current app already uses the features that matter for this workload: compound indexes, bounded range scans, bulk writes, and transactions. A migration away from Dexie would replace mature code for projections, generations, checkpoints, leases, and account fencing without addressing serial HTTP latency.

### RxDB

RxDB's own storage guidance recommends the free Dexie storage or Premium IndexedDB storage for larger browser datasets; it says the Premium IndexedDB implementation is only "a bit faster" and smaller ([RxStorage guidance](https://rxdb.info/rx-storage.html)). Its OPFS page reports higher raw performance, while also warning that worker serialization can outweigh the storage gain for inserts and bulk operations ([RxDB OPFS storage](https://rxdb.info/rx-storage-opfs.html)). The production OPFS, optimized IndexedDB, SQLite, and worker plugins are Premium ([RxDB pricing](https://rxdb.info/premium/)).

RxDB would be attractive if the project needed general conflict resolution, replication adapters, encryption, or arbitrary observable document queries. The current domain has a simpler server-authored Activity stream and a small local outbox, so these layers mainly add migration and runtime cost.

### PGlite

PGlite supplies real Postgres in WASM, transactions, SQL, and live queries. Its live extension supports windowed results and incremental queries that transfer only changes to JavaScript ([PGlite live queries](https://pglite.dev/docs/live-queries)). Its multi-tab worker proxies tabs to a single elected PGlite leader because PGlite has one connection ([PGlite multi-tab worker](https://pglite.dev/docs/multi-tab-worker)).

However, the official filesystem guide currently recommends IndexedDB in browsers because the OPFS VFS is not supported by Safari, and notes that the IndexedDB VFS loads database files into memory at startup and flushes changed files after queries ([PGlite filesystems](https://pglite.dev/docs/filesystems)). This makes PGlite a useful prototype for complex SQL projections, but not a low-risk performance swap.

### LiveStore

LiveStore combines event sourcing, reactive SQLite, and a sync backend ([LiveStore repository](https://github.com/livestorejs/livestore)). The official web adapter uses a dedicated worker plus a SharedWorker and OPFS; it adds roughly 180 KB gzipped of JavaScript plus roughly 300 KB gzipped of SQLite WASM. It requires OPFS, SharedWorker, Web Locks, and WASM, and currently does not work on Android browsers without SharedWorker ([LiveStore web adapter](https://docs.livestore.dev/reference/platform-adapters/web-adapter/)).

Moving Activity ingestion and user state into LiveStore events would replace the existing D1 sequence protocol, projection generations, and tab coordinator. That may simplify a collaborative multi-writer product, but this feed is predominantly server-authored and gains little from event-sourced conflict machinery.

### Electric

Electric streams filtered Postgres shapes and ongoing changes to clients. PGlite's Electric extension can apply multi-table updates transactionally ([PGlite Electric sync](https://pglite.dev/docs/sync)). This can be an excellent architecture when Postgres is already authoritative. It is not a drop-in acceleration for D1: Electric's deployment model depends on Postgres and its replication/change stream. Adopting it would mean replacing the cloud database and sync protocol, not merely choosing a faster local store.

### PowerSync

PowerSync's Web SDK uses WA-SQLite and offers OPFS VFS implementations that it says generally improve performance over IndexedDB ([PowerSync Web SDK](https://docs.powersync.com/client-sdks/reference/javascript-web)). Its setup guide requires a Postgres, MongoDB, MySQL, or SQL Server source database and a PowerSync service ([PowerSync setup](https://docs.powersync.com/intro/setup-guide)). It therefore has the same mismatch as Electric: potentially better packaged sync, but only with a major backend migration and additional service.

### Direct SQLite/WASM and OPFS

OPFS synchronous access handles are worker-only and offer performance benefits, but only one normal sync access handle may be open for a file at once ([MDN createSyncAccessHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle)). SQLite's official WASM persistence documentation warns that opening the same OPFS database in a second tab can produce a lock error ([SQLite WASM persistence](https://sqlite.org/wasm/doc/trunk/persistence.md)). Libraries work around this through leader workers or specialized VFS implementations, but those mechanisms recreate coordination already present in the current design.

## Proposed performance experiment

Before changing storage engines, add one cold-sync trace with:

- manifest duration;
- per-page server duration, download duration, decoded bytes, and row count;
- JSON decode duration;
- per-page Dexie transaction duration;
- projection-build duration;
- first locally renderable Activity and fully synchronized timestamps.

Then prototype one protocol change:

- capture `throughSeq` once;
- stream all retained rows in keyset order in one HTTP response;
- frame chunks so the client can commit, for example, 500–1,000 rows plus an intermediate continuation atomically;
- advance `stableThroughSeq` only after the terminal frame;
- resume from the last committed cursor after interruption.

This preserves current correctness properties while eliminating most serial browser round trips. If the final trace shows local commits or projections dominating after that change, benchmark current Dexie against **one** PGlite/OPFS or direct wa-sqlite worker prototype using the actual Activity schema and filters. Do not use generic database benchmarks as the migration decision.

## Conclusion

There are locally faster engines in the awesome-local-first list, especially OPFS-backed RxDB and SQLite/WASM variants. None is likely to make the observed initial sync materially faster because the observed path is dominated by serial network protocol latency. Electric and PowerSync can improve sync as a whole, but only by introducing a new service and replacing D1 with a supported replication source. LiveStore and PGlite offer richer local SQL/reactivity at substantial browser and migration cost.

For Better GitHub Feed, Dexie remains the best performance-to-complexity choice. The next optimization should be **one resumable streamed bootstrap**, followed by measurement; a local-engine migration should remain contingent on evidence that IndexedDB is still the bottleneck.
