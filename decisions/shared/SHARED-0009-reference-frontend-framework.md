---
id: SHARED-0009
title: "Reference Frontend Framework"
status: Proposed
version: 0.1
area: shared
date: 2026-10-08
supersedes: SHARED-0004
license: CC-BY-4.0
---

# Shared Design Decision 9: Reference Frontend Framework

## Decision

The HiveAR reference frontend will be a single-page application built with React and TypeScript. It runs entirely in the browser and communicates with the backend only through the versioned REST API. Its API client and types will be generated from the OpenAPI document the backend publishes. MUI will serve as the primary open-source component library for the reference implementation.

This decision supersedes [Shared Design Decision 4](SHARED-0004-frontend-framework.md), which adopted Blazor WebAssembly with MudBlazor.

## Status of This Proposal

This file is a proposal and is conditional on the adoption of [Wax Design Decision 34](../wax/WAX-0034-primary-programming-language-and-application-framework.md). If the backend language does not change, the case for Shared Design Decision 4 stands and this file should be rejected with it. The revision to the message catalogs in [Shared Design Decision 5](SHARED-0005-frontend-internationalization.md) depends on this proposal.

## Rationale

Shared Design Decision 4 chose Blazor for one overriding reason: a single language across the backend and the frontend. With a Python backend that reason no longer applies. No mainstream browser framework is written in Python, so the frontend is a second language under any choice.

The earlier decision named React as the closest alternative and described its component ecosystem as larger and its developer pool as deeper. Once the single-language argument is removed, those are the deciding factors.

Shared types across the stack are preserved by generation instead of by a shared language. The backend publishes an OpenAPI document describing every command and query. The frontend build generates its TypeScript types and client from that document, so a change to the API contract that the frontend has not absorbed fails the frontend build.

A browser-only application remains the right fit for agency-controlled deployment, for the reason the earlier decision gave: it needs no persistent server connection and imposes no special infrastructure requirement beyond serving static files.

## Why Not Server-Rendered Django Templates

Django's own templates, with or without a library such as HTMX, would remove the second language. They are not adopted, because [Shared Design Decision 2](SHARED-0002-decoupled-frontend-and-backend.md) makes the published API the backend's only interface. A server-rendered frontend would live inside the backend process and read application state directly, which is the coupling that decision exists to prevent. The planned workflow designer, entity merge screen, and report builder also need client-side interaction that server-rendered pages handle poorly.

## Component Library: MUI

MUI is an open-source React component library that follows Material Design, the same design language as the library the earlier decision selected. Its core components are published under the MIT license. Its data grid is published in a community edition under the MIT license and in commercial editions with additional features. The reference implementation uses only the MIT-licensed editions of MUI's packages. If the community data grid proves insufficient for large account lists, the reference implementation will adopt another MIT-licensed grid before it adopts a commercial one.

Module authors building their own user interface components are not required to use MUI, but components contributed to the core repository will follow its conventions for consistency.

## Implementation Phasing

**HiveAR v1 (MVP):** Ship with React, TypeScript, and MUI. Core screens: account list and search, account detail, entity detail, payment entry, basic reporting, and admin configuration. The API client is generated from the OpenAPI document in continuous integration.

**HiveAR v2:** Richer components, including the workflow designer, the entity merge screen, and the report builder. Performance work, including code splitting and caching.

**HiveAR v3+:** Mobile-responsive design improvements.

**Breaking change risk: NONE for the backend.** The decoupled architecture in [Shared Design Decision 2](SHARED-0002-decoupled-frontend-and-backend.md) makes the frontend replaceable by design.

## Implications For Contributors

All reference frontend code will be written in TypeScript with strict type checking. API types are generated, never written by hand.

Frontend components must not hardcode user-facing strings. All text will be sourced from message catalogs per [Shared Design Decision 5](SHARED-0005-frontend-internationalization.md).

Frontend components must not format dates, times, currencies, or reference value labels directly. Formatted values will be received from the API or rendered using the browser Intl API with the active locale. For money, the number of minor-unit digits comes from the API and is passed to the formatter.

Frontend code must not contain business logic. Validation, business rules, and compliance logic belong in command handlers on the backend. The frontend submits commands and renders read model responses.
