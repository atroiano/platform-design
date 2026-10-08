---
id: SHARED-0010
title: "Release Rollout, Blue-Green Cutover, and Migration Compatibility"
status: Proposed
version: 0.1
area: shared
date: 2026-10-08
supersedes: none
license: CC-BY-4.0
---

# Shared Design Decision 10: Release Rollout, Blue-Green Cutover, and Migration Compatibility

## Decision

Every release of HiveAR, and of any application built on Wax, will be deployable beside the release it replaces. The new release starts as a second application stack against the same database, takes no user traffic, accepts no commands, writes no events, and is tested there. A proxy switch then sends traffic to it, and the same switch sends traffic back if something is wrong. The two stacks are called blue and green; which one is live alternates from release to release.

To make that possible, everything two adjacent releases share must be compatible in both directions. Every database migration in a release must be safe to apply while the previous release's code is still running. A release writes only what the previous release can read, and reads only what the previous release writes. A zero-downtime upgrade is supported when every component moves by at most one release. An installation further behind upgrades one release at a time, or takes a maintenance window. The database records, for each component, which code releases its schema still supports, and code refuses to run against a database that has moved past it.

## Status of This Proposal

This file is a proposal. It takes effect only if the Foundation adopts it under [GOVERNANCE.md](../../GOVERNANCE.md). It is written against the Python and Django stack proposed in [Wax Design Decision 34](../wax/WAX-0034-primary-programming-language-and-application-framework.md); the rules themselves do not depend on that stack, and only the enforcement tooling named below does.

The revisions to Accepted decisions that depend on this proposal, and on nothing else, are these: the section on reading the stream in [Wax Design Decision 1](../wax/WAX-0001-enriched-event-sourcing.md); the v1 phasing of [Wax Design Decision 2](../wax/WAX-0002-cqrs-model.md), which this proposal makes asynchronous; the database roles in [Wax Design Decision 3](../wax/WAX-0003-database-platform.md); the upgrade tooling line in [Wax Design Decision 6](../wax/WAX-0006-deployment-model.md); the module migration rule in [Wax Design Decision 9](../wax/WAX-0009-module-contract-standard.md); the import validation in [Wax Design Decision 21](../wax/WAX-0021-configuration-management-and-environment-lifecycle.md); the v1 phasing of [Wax Design Decision 24](../wax/WAX-0024-high-availability-disaster-recovery-and-distributed-workloads.md); the section on reading before writing in [Wax Design Decision 26](../wax/WAX-0026-event-schema-versioning.md); the section on releases in [Wax Design Decision 27](../wax/WAX-0027-pending-event-register.md); the patch release and continuous integration sentences in [Shared Design Decision 7](SHARED-0007-devops-and-contribution-lifecycle.md); and the topology in [Shared Design Decision 8](SHARED-0008-reference-deployment-architecture.md). Those files show the text as it would read if this proposal were adopted.

## Why This Matters

Agencies run HiveAR on their own infrastructure and upgrade on their own schedule, as [Wax Design Decision 6](../wax/WAX-0006-deployment-model.md) establishes. The Foundation cannot coordinate a fleet-wide upgrade, cannot see an agency's data, and cannot repair an installation after a bad release. [Shared Design Decision 7](SHARED-0007-devops-and-contribution-lifecycle.md) commits to a support window measured in years, so many releases will be in production at once.

An upgrade that cannot be tried against real data before it takes traffic, and cannot be reversed afterward, is an upgrade agencies will postpone. Postponed upgrades mean unpatched installations and a long tail of old releases that every later release must still be able to upgrade from. A collection floor also cannot stop to wait: payments arrive, files load, and collectors work accounts throughout the day.

## Two Colors, One Database

The reference deployment in [Shared Design Decision 8](SHARED-0008-reference-deployment-architecture.md) runs the application tier as a pair. Each color is a complete application stack: the API process and its background workers, running one release. The reverse proxy sends all user traffic to the live color. The other color is reachable only on a separate preview port, for the operator's testing.

The preview port is read-only. Each color's application listens on two ports, one for live traffic and one for preview traffic, and refuses to run a command that arrives on the preview one. The proxy's preview route leads only there. The refusal rests on which listener a request came in on, not on a header, because anything carried in the request can be forged or stripped by whoever sends it. A color under test can be read through as much as the operator likes and cannot change the agency's data. The deployment step confirms this through the proxy before it offers the color as a candidate.

Both colors connect to the same PostgreSQL database. A second database for the new release is not an option, because the event store defined in [Wax Design Decision 1](../wax/WAX-0001-enriched-event-sourcing.md) is the permanent record of truth. Two databases would mean two histories, and events written to one could never be merged into the other without breaking the hash chains in [Wax Design Decision 13](../wax/WAX-0013-event-chain-integrity-and-tamper-evidence.md). One history, shared by two releases for a short time, is the only arrangement the architecture permits, and it is the reason the compatibility rules below exist.

## What Is Tested Before Cutover

Before a color may take traffic, a smoke check runs inside it. The check is read-only:

- The schema supports every component of this release, and every migration this release needs has been applied.
- The framework's system checks pass.
- Every table and column this release's code expects can be read, and the runtime role holds the privileges the code will use.
- This color's background worker is alive.
- Every projection this release owns has reached the position the event stream was at when the check began, none has stopped on an event, and none is defined differently by the other release.
- Read models agree with the authoritative state they summarize, for a sample of recently changed records.
- Where hash computation is active, the hash chains of recently changed aggregates verify.

The operator can then use the preview port to exercise the new release against live data for as long as needed.

No synthetic transaction is written to the live database. An event in core.event is permanent, so a test payment posted to production would be part of the agency's history forever. Write paths are tested earlier, in a rehearsal: the same deployment procedure run against a restored copy of the production database. In v1 the operator makes that copy with an ordinary backup and restore. The staging lifecycle and the PII redaction utility in [Wax Design Decision 21](../wax/WAX-0021-configuration-management-and-environment-lifecycle.md) arrive in later versions and will make the rehearsal copy safer to handle. The rehearsal also measures how long the release's migrations take on the agency's real data volume.

## Cutover, Rollback, and Finalization

The database holds one deployment record. It names the live color, the candidate color that a deployment has prepared, and the previous color that a rollback would return to. That record is the authority. The proxy's routing is derived from it, and the release tooling refuses to act whenever the record, the routing files, and the color the proxy is actually serving disagree.

Cutover records the candidate as live and then switches the proxy's upstream. If the switch fails, the record is put back. Requests already in flight finish on the old color. No connection is dropped.

Rollback is a separate operation, not the same command run twice. It returns to the previous color, and it is available only while that color is still running. The color that was backed out becomes the candidate again, so a cutover can be retried once the fault is understood.

Finalization stops the old color and clears the previous color from the record. After finalization the previous release can still be brought back, as the idle color, by the ordinary deployment procedure and without any migration, for as long as the schema still supports it.

Migrations run forward only. There are no down migrations in production: what is rolled back is code, never schema.

Because the record lives in the database, a database restore rewinds it. A restore procedure ends by confirming, and if necessary re-recording, which color is live.

The proxy configuration, the Compose file, and the release script are part of a release, although they are not inside its image. An operator updates them with the release, and the deployment step reloads the proxy so that it is never running an older configuration than the script assumes.

## The Migration Compatibility Rule

Every migration in a release must be safe to apply while the previous release's code is running. The previous release must be able to read and write through the new schema without error and without corrupting data, both during the testing period and after a rollback.

| **Change** | **How it ships** |
| --- | --- |
| Add a table | In one release. The migration that creates it grants it to the runtime role, or default privileges do. |
| Add a column | In one release, nullable or with a constant database default, and with nothing else in the same statement: no index, no unique or foreign key constraint, no check, and no generated or volatile default. |
| Add an index | In one release, built concurrently, alone in its own migration. |
| Add a check or foreign key constraint | As not valid in one migration and validated in a later migration, and only when every row the previous release writes already satisfies it. |
| Add a unique constraint | By building a unique index concurrently and then attaching it as the constraint, under the same condition. |
| Remove a constraint or an index | With a written review. A constraint is a guarantee the previous release's code was written against. |
| Remove a column or a table | In two releases. The first stops using it and makes it optional. A later one drops it, never by cascade. |
| Rename a column or a table | Never in place. Add the new one and write both. In a later release, reconcile the two and move reads while still writing both. Then stop writing the old one, and finally remove it. This spans four releases, or three when a database trigger keeps the two in step for every writer. |
| Change a column's type or meaning | As a rename. |
| Replace a view, a function, or a trigger | Only when the replacement is correct for both releases' callers. Otherwise the new behavior ships under a new name, and the old object is removed under the removal rule. A view is never dropped as a side effect of dropping a column. |
| Change a seeded or reference row that alters behavior | Never in place. The release adds a new versioned definition that only its own code selects, so that the switch and the rollback govern it exactly as they govern code. |
| Backfill existing rows | In batches, outside the schema change, idempotent and resumable. |
| Change core.event | Additive nullable columns only, and never anything that alters the hash input. Partitioning the table, which Wax Design Decision 1 plans for a later version, replaces the table and is done in a maintenance window. |

A migration waits for its locks under a short lock timeout, so that one which cannot get a lock fails instead of queuing every request on the table behind it, and the release tooling retries. The timeout limits waiting, not holding, which is why index builds are concurrent and constraints are validated in a migration of their own. A migration is also one of the transactions that holds the projection reader's high-water mark, so migrations are kept short.

A backfill of an authoritative state table is permitted without events only when it changes representation and no fact: copying a value into a new column, for example. The state remains exactly what replaying the event history would produce. A change to a fact is a command that writes events, run by the system actor, and never a data step in a migration.

## Database Roles

The application connects to the database as a runtime role. It can append events and maintain state. It cannot alter the schema, cannot update or delete events, and cannot change the deployment record. A running color therefore cannot change the database out from under the other color.

Migrations run under a separate owner role, used only by the release tooling. Other decisions describe features that change the schema or the event store at an administrator's request: module installation and removal under [Wax Design Decision 10](../wax/WAX-0010-module-registry.md), user-defined tables under [Wax Design Decision 22](../wax/WAX-0022-user-defined-tables-and-user-defined-windows.md), the generated read layer under [Wax Design Decision 16](../wax/WAX-0016-data-access-architecture-read-layer-and-direct-query-interface.md), and the hash backfill and break-glass procedures under [Wax Design Decision 13](../wax/WAX-0013-event-chain-integrity-and-tamper-evidence.md). None of these runs with the runtime role. Each runs through the release tooling under the owner role and is held to the compatibility rule. Physically removing a module is a removal, and is unavailable while a previous color could still return. How user-defined tables are created without handing the runtime role the power to alter the schema is an open point for that decision's own later phase.

## What Two Releases Share Besides the Schema

**A release writes only what the previous release can read.** A new schema version of an existing event type cannot be interpreted by the previous release, so the reader ships one release ahead of the writer, as [Wax Design Decision 26](../wax/WAX-0026-event-schema-versioning.md) specifies. The same holds for a new event type on an aggregate type that the previous release already projects or handles: after a rollback, a projection that passed over an event which changed a balance would show the wrong balance with no sign of trouble. It holds as well for a new value in an existing column or payload key, such as a new status or a new posting kind. Only an event type on a new aggregate type, which no existing code reads, needs no staging. As a backstop, a projection declares the aggregate types it covers and stops, visibly, on an event type it neither handles nor has declared it ignores.

**A release reads only what the previous release writes.** This is the mirror of the first rule. A release may read, verify, or depend on a column or a value only if the previous release already writes it, or the database itself maintains it. Without this, the previous release keeps writing rows during the testing period and after a rollback that the new release then misreads. The rule is why a rename takes four releases, and it will govern the activation of hash verification: the release that verifies hashes follows a release that writes them.

**Projections are versioned, pinned, and free of side effects.** A projection is identified by its name and a version, and each version has its own checkpoint and its own read model table. A release that changes a projection's logic or its table's shape registers a new version. The new color's worker builds that version from the start of the event stream while the old color keeps the previous version current. The checkpoint records a fingerprint of the version's definition, and a worker whose definition differs refuses to touch it, so two releases cannot share a version they disagree about. A version both releases define identically is maintained by either color's worker, and the checkpoint lock keeps them from handling an event twice.

A projection handler affects nothing but its own read model. A table that holds claims, or a fired or done status, is not a projection, even where another decision describes it as one. The Pending Event Register in [Wax Design Decision 27](../wax/WAX-0027-pending-event-register.md) is one shared table, changed only under the migration compatibility rule. It is not rebuilt per release, because rebuilding it from scheduling and cancellation events alone would present every past entry as pending again. The job schedule in [Wax Design Decision 28](../wax/WAX-0028-job-scheduler.md) records each firing as an execution event and so can be rebuilt, but it too is one shared store, and its claims follow the rule below.

**Singleton work runs on the live color only, and a run belongs to the color that started it.** Scheduled jobs, pending events, workflow evaluation under [Wax Design Decision 23](../wax/WAX-0023-workflow-automation-engine.md), and batch work under [Wax Design Decision 24](../wax/WAX-0024-high-availability-disaster-recovery-and-distributed-workloads.md) are claimed only by workers of the color the database records as live. A batch run records the color that started it, and only that color claims its chunks. Finalization waits for such a run or cancels it. A rollback cancels the unclaimed chunks of runs started by the color being backed out, and reports them. A command issued by a fired entry or a batch row takes its idempotency key from that entry or row, so that work claimed on both sides of a switch cannot take effect twice.

**New capabilities are switched on after finalization.** Some changes are additive to the schema and still cannot be undone by the previous release: a new kind of record that only the new release knows how to reverse, for example. Such a capability ships switched off. Switching it on is a deliberate action by the owner role, recorded in the deployment record, and it raises the oldest supported code release to the release that introduced it. From that moment the interlock refuses a return to the previous release, which is correct, because the previous release could no longer keep the books straight. Before that moment, rollback is safe. Release notes list every such switch.

**The API is compatible in both directions.** A release serves every API version the previous release served, unless the previous release had already marked that version deprecated under [Shared Design Decision 3](SHARED-0003-api-surface.md). A release's frontend works against the previous release's backend for anything added within an existing API version, or it compares the release the health endpoint reports with its own and reloads. A browser holding either frontend therefore keeps working across a cutover and across a rollback. While both colors are running, the proxy looks on the other color for a static file the live color does not have, so a page loaded before the switch can still fetch what it was built to load.

## Installations on Different Releases

Each agency is on whatever release it last installed, and Wax, HiveAR, and each module version independently under [Shared Design Decision 1](SHARED-0001-repository-architecture-and-layer-separation-wax-and-hivear.md). The unit of compatibility is therefore the component, not the installation.

**The database knows what it supports, per component.** A component record holds one row for Wax, one for HiveAR, and one for each installed module, and later one for the security module. Each row holds the release whose migrations were last applied, the oldest code release that schema still supports, and the release now serving users. Every process checks the record at startup and continuously afterward, and reports it on its health endpoint. A process carrying a component older than its minimum refuses to serve and refuses to write. A process whose image lacks a component the database records refuses as well.

**One release at a time, without downtime.** A blue-green upgrade is supported when every component moves by at most one minor release from the release now serving users. The release tooling checks this against the live release, not against the last migration applied, and refuses a deployment that would strand the live color. It tells the operator to hop or to take a window instead.

**Any distance, with a maintenance window.** An installation further behind may hop through the intermediate releases one at a time, or stop the application, apply every outstanding migration, and start the new release. The offline path is supported from any earlier release within the same major version and from the last minor release of the previous major version. Whether a major version boundary can be crossed without a window is decided for each major release and stated in its release notes.

**Patch releases carry only additive migrations.** A patch may add a table, a nullable column, or a concurrently built index, which are the changes the compatibility rule allows in a single release. It removes and alters nothing. A migration needed on more than one release line is written on the oldest line first and carried forward unchanged, under the same name. An installation moving from the patch to a newer release then finds nothing missing and nothing applied twice, and the release a migration states is never later than the release that carries it.

**Schemas are never downgraded, and the record is never lowered.** An earlier release that the schema still supports is deployed as code only.

**Modules follow the same rules on their own schedule.** A module's migrations are held to the compatibility rule against the module's own previous release. Its manifest, under [Wax Design Decision 9](../wax/WAX-0009-module-contract-standard.md), declares the range of Wax and HiveAR releases it supports, and lists each event type it reads from another component with the highest schema version it handles. The release tooling refuses an upgrade that would leave an installed module outside its declared range, and refuses a release that would write an event version beyond what an installed consumer reads. Wax and HiveAR remove or change nothing a module may rely on, whether a table, a column, an event type, or an interface method, except under the removal rule.

**Configuration moves between installations by the same test.** An import under [Wax Design Decision 21](../wax/WAX-0021-configuration-management-and-environment-lifecycle.md) is validated against the releases the target is running, not only against its schema, so that a package exported from a newer installation cannot introduce what the target's live code does not read.

## Enforcement

A static check runs in continuous integration and again, from the new release's own image, before any migration is applied. Every migration states the release it shipped in. The check passes plain additive changes. It rejects a required column without a database default, a column added together with an index or a constraint, and a non-concurrent index on an existing table. It verifies a removal by finding the earlier migration in which the code stopped using the column or table, and confirming that it shipped in an earlier release. Every other operation, including each constraint, each hand-written SQL or data step, and each change the check cannot analyze, must be wrapped individually in a review marker that carries a written reason.

The release tooling checks the component record before it migrates, and the application checks it on every command and in the worker loop.

A compatibility test will run the previous release's test suite against a database migrated by the candidate release. This is the direct test of the rule: old code, new schema. An upgrade path test will migrate a schema snapshot of each supported release to the candidate, covering the offline path. Both need a previous release to exist.

Release notes list every migration in the release with its classification, and every capability switch, so an operator can see before upgrading whether anything is being removed or whether rollback will close.

A draft implementation rehearses the procedure end to end, and the rehearsal can be rerun from the draft's source. It installs one release, keeps payments flowing from a single client, and deploys a second release whose migration adds a column while the first is still serving. It cuts over, rolls back onto the first release, which then serves against the new schema, cuts over again, and retires the first release, with no failed request and with matching balances and hash chains afterward. It then shows a release two steps ahead refused, and the same jump completed by the offline path. Finally it runs the first release's own test suite against the second release's schema. The rehearsal's releases are builds of one source tree under successive release numbers, the second carrying one extra migration. It therefore tests the procedure, the interlock, and an additive schema change. It does not test a change in application behavior between releases.

## What This Decision Does Not Cover

Database failover and replication are the subject of [Wax Design Decision 24](../wax/WAX-0024-high-availability-disaster-recovery-and-distributed-workloads.md); a blue-green pair runs against whatever database topology that decision provides. Upgrading PostgreSQL itself across major versions is an operator procedure outside this decision.

The procedure is specified for the container reference deployment. Native operating system packages and Windows Server installations will need an equivalent before either is supported.

Splitting user traffic between two releases by percentage is deliberately not adopted. It would have two releases taking writes side by side for long periods, which multiplies the exposure the rules above are designed to keep brief. Cutover moves all traffic at once.

## Implementation Phasing

**Wax v1 (MVP):** The migration compatibility rule and its static check, in force from the first release an agency installs. The deployment record, the component record, and the interlock at startup, on every command, and in the worker loop. The runtime and owner database roles. Asynchronous, versioned, pinned projections, which replaces the synchronous option that [Wax Design Decision 2](../wax/WAX-0002-cqrs-model.md) previously allowed for v1. The blue-green reference Compose file with a read-only preview port and a release script covering deploy, cutover, rollback, finalize, and the offline upgrade. The read-only smoke check. Forward-only migrations. During an upgrade, two application stacks run against the single v1 database, coordinated by the projection checkpoint lock.

**Wax v2:** The compatibility test against the previous release and the upgrade path test in continuous integration. Module ranges and consumed event versions in the manifest, when the manifest itself ships. The run-level claim rules, when the scheduler and batch engine ship. Capability switches. The read-before-write check for event schema versions, when upcasting activates. Rehearsal tooling built on configuration export. A blue-green variant of the high-availability reference configuration.

**Wax v3+:** Rehearsal copies made with the PII redaction utility. Equivalent procedures for Kubernetes. Automated draining of long batch work at finalization.

**Breaking change risk: LOW if adopted before the first agency installs, HIGH afterward.** The rules cost little to follow from the first migration. Retrofitting them onto a schema history that already contains in-place renames and required columns means a release that cannot be rolled back.

## Implications For Contributors

Every migration is written for two releases of code: the one that ships it and the one before. A contributor who cannot say what the previous release does with the changed table has not finished the migration.

Removing anything in the database takes at least two releases, and renaming takes more. The pull request that stops using a column is separate from the pull request that drops it.

An operation the static check cannot prove safe is wrapped in a review marker with a reason, one operation at a time, and a reviewer reads it. The marker is part of the contribution, not a way around the check.

A release writes nothing the previous release cannot read, and reads nothing the previous release does not write. A new event type on an existing aggregate, a new schema version, and a new value in an existing column all follow a release that handles them.

A change to a projection's logic or to the shape of its read model is a new projection version. A projection handler has no effect outside its own read model.

Background work that must not run twice checks that its color is live before it claims anything, and carries an idempotency key taken from what it is acting on.

A capability the previous release could not undo ships switched off.

No test, script, or smoke check may write a domain event to a production database.
