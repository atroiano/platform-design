---
id: WAX-0034
title: "Primary Programming Language and Application Framework"
status: Proposed
version: 0.1
area: wax
date: 2026-10-08
supersedes: WAX-0025
license: CC-BY-4.0
---

# Wax Design Decision 34: Primary Programming Language and Application Framework

## Decision

Wax will be built in Python on the Django framework. Python is the primary language for the Wax engine, all modules, all API layers, and all server-side application code. Django supplies the application structure, the object-relational mapper, and the migration system. Django Ninja supplies the REST layer, and Pydantic supplies command and event payload schemas. The event store is implemented inside Wax, directly on PostgreSQL, rather than through a third-party event sourcing library. The Wax Security Module is the single exception to the language rule: it will be a separately compiled component, as [Wax Design Decision 15](WAX-0015-security-module.md) requires.

This decision supersedes [Wax Design Decision 25](WAX-0025-primary-programming-language.md), which adopted C# on the .NET runtime with the Marten library.

## Status of This Proposal

This file is a proposal. It takes effect only if the Foundation adopts it under [GOVERNANCE.md](../../GOVERNANCE.md).

The revisions to Accepted decisions that depend on this proposal are these: the event store abstraction in [Wax Design Decision 1](WAX-0001-enriched-event-sourcing.md); the data access pattern in [Wax Design Decision 3](WAX-0003-database-platform.md); the module contract in [Wax Design Decision 8](WAX-0008-extensibility-construct-nomenclature.md), [Wax Design Decision 9](WAX-0009-module-contract-standard.md), and [Wax Design Decision 10](WAX-0010-module-registry.md); the enforcement wording in [Wax Design Decision 13](WAX-0013-event-chain-integrity-and-tamper-evidence.md); the build of the security module in [Wax Design Decision 15](WAX-0015-security-module.md); the action type interface in [Wax Design Decision 23](WAX-0023-workflow-automation-engine.md); the broker transport in [Wax Design Decision 24](WAX-0024-high-availability-disaster-recovery-and-distributed-workloads.md); the upcaster in [Wax Design Decision 26](WAX-0026-event-schema-versioning.md); the protocol server in [Wax Design Decision 31](WAX-0031-ai-agent-infrastructure.md); the parser in [Shared Design Decision 6](../shared/SHARED-0006-file-interface-engine.md); and the release artifacts in [Wax Design Decision 6](WAX-0006-deployment-model.md) and [Shared Design Decision 7](../shared/SHARED-0007-devops-and-contribution-lifecycle.md). Those files show the text as it would read if this proposal were adopted. Two of them, Wax Design Decisions 9 and 26, carry a changed Decision section and a new major version on that basis. The rollout rules in [Shared Design Decision 10](../shared/SHARED-0010-release-rollout-blue-green-cutover-and-migration-compatibility.md) are a separate proposal and can be adopted or declined without this one.

## Why Reopen the Language Decision

Wax Design Decision 25 rested on five arguments. Each is addressed here.

**Platform and deployment.** The earlier decision's first argument was that .NET runs identically on Windows Server and Linux and ships as self-contained packages. Python and Django also run on both, but less evenly: the application server named below runs on Linux only, so a Windows Server installation would need a different one, or would run the Linux containers. This proposal makes container images the release artifact and Linux the v1 target, and it drops the v1 Windows installer that [Shared Design Decision 7](../shared/SHARED-0007-devops-and-contribution-lifecycle.md) had planned. For an agency standardized on Windows Server without containers that is a real loss, and it is listed among the costs below.

**Architectural fit.** The earlier decision named the Marten library as its most significant technical factor. [Wax Design Decision 1](WAX-0001-enriched-event-sourcing.md) does not describe a generic event store. It specifies one table, a fixed payload schema, two sequence numbers, hash chain columns, and authoritative state tables written in the same transaction as each event. A library that brings its own event schema has to be bent to that shape. A working draft built against these decisions implemented the append operation with expected-version concurrency, stream loading, per-aggregate hash chaining, and an asynchronous projection reader in about 750 lines of Python and SQL. Size is not the whole measure. The reader, the part the earlier decision credited to Marten, was the hardest piece: independent review found defects in the draft's first versions of it, which were fixed and are now specified in Wax Design Decision 1. Upcasting and projection rebuild tooling, which Marten would also have supplied, are not built. The claim here is narrower than the earlier decision's: the part a library would supply is tractable, and the part specific to Wax is most of the work on either stack.

**Contributor community.** The earlier decision cites research into job postings and developer profiles, which is not published in this repository, and it compared C# with Java and Kotlin, not with Python. This proposal does not claim the opposite as fact. It rests on a different expectation: that the people most likely to extend an agency's installation are analysts and operations staff who script, not application developers who compile, and that the custom action types in [Wax Design Decision 23](WAX-0023-workflow-automation-engine.md), the custom file parsers in [Shared Design Decision 6](../shared/SHARED-0006-file-interface-engine.md), and the AI agent tooling in [Wax Design Decision 31](WAX-0031-ai-agent-infrastructure.md) are all more approachable in Python. That expectation is an assumption, and Year 1 will test it.

**Founder familiarity.** The earlier decision is correct that the founding development team's primary expertise is C#. This proposal accepts that cost. It weighs against it a concentration risk that exists in any language: foundational code is a liability for a community-governed project for as long as only its founding group maintains it. This proposal expects, without evidence yet, that a widely taught language with a batteries-included framework lowers the bar for a second and third maintainer.

**Open-source library availability.** The complete stack below is available under open-source licenses at no cost, as the earlier decision's stack was. Licensing does not separate the two choices.

## The Stack

| **Concern** | **Choice** | **License** |
| --- | --- | --- |
| Language runtime | CPython, current stable release | PSF License |
| Application framework, object-relational mapper, and migrations | Django, current long-term support release | BSD 3-Clause |
| REST layer and OpenAPI document | Django Ninja | MIT |
| Command and payload schemas | Pydantic | MIT |
| PostgreSQL driver | psycopg 3 | LGPL 3.0 |
| Application server | Gunicorn | MIT |
| Testing | pytest | MIT |
| Static analysis | Ruff and Pyright | MIT |
| Optional broker transport, Wax v3 and later | Kombu | BSD 3-Clause |
| Security module | A compiled language, decided when the module is extracted in v2 | To be decided |

psycopg is used as an unmodified library dependency. Its license differs from the permissive licenses in the rest of the table, and the Foundation's license review should confirm the combination before adoption.

## How the Design Maps onto Django

A module is a Django app distributed as its own Python package, as [Wax Design Decision 9](WAX-0009-module-contract-standard.md) specifies. Each app owns one PostgreSQL schema and its own migrations, which is the schema ownership rule in [Wax Design Decision 4](WAX-0004-schema-architecture-and-module-extension-pattern.md) expressed in the framework's own terms.

Authoritative state tables are Django models that refuse any write made outside a command handler. The core.event table is created by a hand-written SQL migration and is written only by the event store, never through the object-relational mapper.

Django's system check framework runs at startup and in continuous integration. Wax uses it to enforce the module contract and the PII classification rule in [Wax Design Decision 13](WAX-0013-event-chain-integrity-and-tamper-evidence.md), so an application with a non-conforming module does not start.

Several Django features are deliberately not used, because each would open a write path around the command pipeline or duplicate a Wax subsystem: the admin site, model forms, server-rendered views and sessions, and the built-in permission model. Access control remains as specified in [Wax Design Decision 18](WAX-0018-access-control.md).

## What This Decision Costs

The Foundation maintains its own event store and projection reader. The reader must handle transactions that commit out of sequence order, and [Wax Design Decision 1](WAX-0001-enriched-event-sourcing.md) now specifies how.

There is no compiler to enforce the module contract. Static type checking, startup checks, and the conformance check in Wax Design Decision 9 replace it. That is a weaker guarantee than the one Wax Design Decision 25 offered, and it is untested: the draft implementation does not yet run a type checker or a contract check.

Windows Server without containers is no longer a v1 target, and there is no v1 Windows installer.

The security module needs a second, compiled language, because a Python package cannot be shipped as a single signed binary that attests to its own contents.

Python is slower than .NET on processor-bound work. Statement runs, interest accrual, and payment application over a large portfolio must be designed as set-based SQL and chunked batches under [Wax Design Decision 24](WAX-0024-high-availability-disaster-recovery-and-distributed-workloads.md), and batch throughput must be measured against a realistic portfolio before v1 is declared.

Django has no first-class support for multiple PostgreSQL schemas. [Wax Design Decision 3](WAX-0003-database-platform.md) records the convention Wax uses to work within that limit.

The founding team works outside its strongest language during the period when architectural judgment matters most.

## Invariants

Hash chain integrity is unchanged. The hash input, the per-aggregate chain, and the row lock that serializes writes to one aggregate are as specified in [Wax Design Decision 13](WAX-0013-event-chain-integrity-and-tamper-evidence.md), and the computation remains behind the security module boundary.

Event immutability is unchanged and is enforced in the database by triggers that reject any update, delete, or truncate on core.event, independent of application code.

Schema ownership is unchanged. One Django app owns one schema, and no app defines a model over another app's tables.

Module boundaries are unchanged in intent and weaker in enforcement, for the reason given above. The conformance check is the compensating control.

## Implementation Phasing

**Wax v1 (MVP):** Full implementation. Python on the current Django long-term support release, with the in-house event store. This is decided at adoption and does not phase.

**Breaking change risk: NONE once adopted.** The risk lies in adopting it late. Changing the primary language after substantial code exists is a rewrite.

## Implications For Contributors

All Wax and module server-side code will be written in Python, type-annotated, and checked by Pyright in strict mode in continuous integration.

Contribution guidelines will specify the minimum supported Python and Django versions and will be updated as new long-term support releases are adopted.

Contributors may not register models with the Django admin site, write to an authoritative state table outside a command handler, or write to core.event by any route other than the event store.

The reference frontend is adopted in [Shared Design Decision 9](../shared/SHARED-0009-reference-frontend-framework.md). The backend and the frontend no longer share a language, and the published API contract is the only thing they share.
