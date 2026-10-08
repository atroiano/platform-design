# Django draft of Wax and HiveAR

A working vertical slice of the design in this repository, written in Python on Django with a React frontend, and run with Docker Compose. It is the draft implementation that [WAX-0034 Primary Programming Language and Application Framework](../decisions/wax/WAX-0034-primary-programming-language-and-application-framework.md) and [SHARED-0010 Release Rollout, Blue-Green Cutover, and Migration Compatibility](../decisions/shared/SHARED-0010-release-rollout-blue-green-cutover-and-migration-compatibility.md) cite as evidence.

It is offered here, on a fork, so that the claims in those two proposals can be checked by running it. It is not proposed for merge into the design repository, which is prose by design: if the proposals go anywhere, this code belongs in a repository of its own. The code is offered under the Apache License 2.0, the license in [LICENSE-CODE](../LICENSE-CODE).

## Run it

```bash
make up
```

```bash
make test
```

```bash
make drill
```

`make up` builds a release image, migrates, and starts it as the blue stack. The application is then at `http://localhost:8580/` and `https://localhost:8543/`. Sign in with the development key, `local-evaluation-only` unless `.env` changes it. The API is under `/api/v1/`, with interactive documentation at `/api/v1/docs`; API callers send the same key in the `X-API-Key` header. Copy `.env.example` to `.env` to change the secrets.

`make drill` rehearses a whole upgrade, and takes several minutes. It runs in its own Compose project, ports, and volume, so it does not touch an installation started with `make up`. It installs one release, keeps payments flowing, and deploys a second release whose migration adds a column while the first is still serving. It cuts over, rolls back onto the first release, cuts over again, and retires the old stack. It then checks that no request failed and that balances and hash chains agree, and that the refusals work: the preview port will not take a payment, and a release two steps ahead is refused until the offline path is used. Last, it runs the first release's own test suite against the second release's schema.

The three releases in the drill are builds of this one source tree under successive release numbers, and the second carries one extra migration from `deploy/drill-next-release/`. The drill therefore tests the procedure, the interlock, and an additive schema change. It does not test a change in application behavior between releases.

## The frontend

`frontend/` is a single-page application in React and TypeScript with MUI, as [SHARED-0009 Reference Frontend Framework](../decisions/shared/SHARED-0009-reference-frontend-framework.md) proposes. It talks to the API and to nothing else.

| Screen | What it does |
| --- | --- |
| Sign in | Takes the development key. There are no user accounts yet. |
| Accounts | Lists and searches accounts, places a new one, and takes one payment across several selected accounts. |
| Account | Shows the balance and its buckets in payment order, takes a payment, records a dispute, lists every payment taken against the account, and shows the audit history a page at a time, newest first. |
| Payments | Lists every payment received, newest first, with a filter for payments still holding unapplied money. Money that was not applied to an account can always be found here. |
| Receipt | Shows what a payment did, account by account, and what was left unapplied. It opens after every payment and from any row of the payment list, and it is where a payment is reversed. |

The release image builds it. The build first exports the API's OpenAPI document, generates the TypeScript types from it, type-checks, and runs the unit tests, so a frontend that has not absorbed an API change fails the build. The built files are copied into the same image as the API and served by the same color, which is why the frontend switches with a cutover. A page loaded from one build notices when another build starts answering and offers to reload. On the preview port it says the view is read-only and disables every action.

Three things are deliberate, because this screen takes money:

- An amount is refused unless it is plainly an amount. A grouping separator in the wrong place, such as `125,50` where a comma groups thousands, is an error and not a guess, and every money field says how it read what was typed before anything is sent. The number of minor-unit digits comes from the server, per currency, never from the browser.
- A payment is sent under a key made when the form opens. The server answers a repeat of the same payment under the same key as the same payment, so a retry after a lost response cannot post twice. When no answer arrives, the form looks the payment up before it lets the person try again.
- After a command the page waits for the read models to pass the position the command reported, then refreshes. If that takes too long it says so and refreshes when they do. If a read model has stopped, a banner says the screens may be out of date.

To work on it outside Docker, with the stack from `make up` running:

```bash
make openapi
```

```bash
cd frontend && npm install && npm run generate && npm run dev
```

## Upgrading a running installation

The procedure is the one in [SHARED-0010 Release Rollout, Blue-Green Cutover, and Migration Compatibility](../decisions/shared/SHARED-0010-release-rollout-blue-green-cutover-and-migration-compatibility.md). The database's deployment record is the authority on which color is live, and every command refuses to act when the record, the routing files, and the proxy disagree.

| Step | Command | What happens |
| --- | --- | --- |
| Build | `make image RELEASE=0.2.0` | Builds the release image. |
| Deploy | `deploy/bluegreen.sh deploy hivear-draft:0.2.0` | Checks the migrations and the upgrade path, migrates while the live stack keeps serving, starts the new release as the idle color, runs the read-only smoke check, and records it as the candidate. |
| Test | open `http://localhost:8581` | The preview port reaches the idle color only, and it is read-only. |
| Cut over | `deploy/bluegreen.sh cutover` | Records the candidate as live and switches the proxy. |
| Roll back | `deploy/bluegreen.sh rollback` | Returns to the previous color. Available until that color is stopped. |
| Finalize | `deploy/bluegreen.sh finalize` | Stops the previous color. |
| Skip releases | `deploy/bluegreen.sh upgrade-offline hivear-draft:0.4.0` | Stops the application, migrates, and starts the new release. Users see errors meanwhile. |
| Recover | `deploy/bluegreen.sh start`, `repair`, `status` | Bring a stopped installation back as recorded, rewrite the routing from the record, or show whether everything agrees. |

`deploy/compat_test.sh <previous image> <candidate image>` is the direct test of the migration rule: it runs the previous release's own test suite against a database the candidate migrated.

`python manage.py check_migrations` is the static migration check. It runs before every deploy and belongs in continuous integration. A migration written after the first release states `wax_release`, uses `wax.migration_operations.DropColumn` and `DropTable` for the second half of a removal, and wraps anything the check cannot prove safe in `Reviewed(operation, reason=...)`.

## What is implemented

| Decision | Where | Notes |
| --- | --- | --- |
| WAX-0001 Enriched Event Sourcing | `wax/store.py`, `wax/migrations/0001_core_schema.py` | Single `core.event` table with the full standard payload schema, prior and new values, both sequence numbers, and state written in the same transaction. |
| WAX-0002 CQRS Model | `wax/commands.py`, `wax/projections.py` | One handler per command, no return value. Reads come from a read model. |
| WAX-0004 and WAX-0005 | `hivear/models.py` | `core` and `ar` schemas, singular tables, `_pk` and `_fk` naming. |
| WAX-0013 Event Chain Integrity | `wax/hashing.py`, `verify_chain` command | Per-aggregate SHA-256 chain, computed on every write. No checkpoint anchoring, no break-glass. |
| WAX-0020 Reason Code Registry | `hivear/migrations/0003_reason_codes.py` | Four codes, enough for the commands here. |
| HIVE-0005 Account Structure and Balance Composition | `hivear/models.py` | Balances are bucket rows moved only by posted events. No balance column on the account. |
| HIVE-0007 Payment Application and Waterfall | `hivear/allocation.py`, `hivear/handlers.py` | Waterfall, per-payment override, consumer-directed allocation, disputed-account exclusion, even split, oldest first, and reversal of the recorded distribution. |
| SHARED-0003 API Surface | `hivear/api.py` | One endpoint per command or query under `/api/v1/`, each with a declared response schema. |
| SHARED-0009 Reference Frontend Framework | `frontend/` | React, TypeScript, and MUI, with API types generated from the OpenAPI document. |
| SHARED-0008 Reference Deployment Architecture | `docker-compose.yml` | Two application stacks, PostgreSQL, pgBouncer, and a TLS proxy with a preview port. |
| SHARED-0010 Release Rollout | `deploy/bluegreen.sh`, `wax/migration_safety.py`, `wax/release.py`, `wax/projections.py` | Deploy, cutover, rollback, and finalize; the static migration check; the schema interlock; versioned projections; a runtime database role that cannot alter the schema or change history. |

## What is not implemented

Identity and access control (WAX-0017, WAX-0018) are a single shared key and a fixed actor. There is no PII encryption or security module (WAX-0014, WAX-0015), no general ledger (HIVE-0006), no entity model (HIVE-0001 through HIVE-0003), no module contract or registry (WAX-0009, WAX-0010), no workflow engine (WAX-0023), and no reporting role or view layer (WAX-0016). Bucket definitions are plain configuration rows rather than versioned configuration (WAX-0021). Money left over after every eligible bucket is paid is recorded on the payment as unapplied; the consumer credit balance from HIVE-0006 is not modeled.

## Departures from the decision text

- The hash is computed in application code, standing in for the security module.
- The schema check that WAX-0003 requires, rejecting a model whose table falls outside its app's schema, is not written.
- Wax and HiveAR are recorded as two components and carry one release number, because this draft is one image.
- SHARED-0009 describes the frontend as its own versioned artifact. Here it is built into the release image and served by the application container, so that it switches with its color.
- SHARED-0005 calls for ICU message catalogs per locale. The frontend keeps every visible string in one English catalog with simple placeholders. Dates and amounts follow the browser's locale.
- Sign-in is the shared development key, held for the browser tab only.
- Seven currencies are enabled, each with a checked number of minor-unit digits. Any other is refused.

## What a review of the frontend found

An independent review of the frontend confirmed 40 problems. All of them are addressed here, and those that touched money, the audit record, or security are covered by tests or by the drill. What is still limited:

- The screens have not been tried with a real screen reader. Fields, tables, and dialogs are labeled, a refused form moves focus to the first field at fault, each page puts focus on its heading, and a live region announces that a command is being recorded, that it was, and how many rows a list holds.
- One language ships. Every visible string is in the message catalog, lists are joined by the browser's locale, and the server names each refusal with a code the catalog translates. The catalog uses simple placeholders, not full ICU plural rules, and when the server rejects a malformed request its field-by-field detail is shown as the server wrote it.
- A debt type is shown as it was typed, because nothing in this draft defines a list of debt types to label.

## What SHARED-0010 specifies and this draft does not yet do

An independent review of the rollout work confirmed 46 problems. The ones in the reader, the migration check, and the release script are fixed here and covered by tests or by the drill. These rules exist in the decision text only:

- Capability switches that raise the oldest supported release when a new kind of record is first written.
- Run ownership and idempotency keys for scheduled and batch work. No such work exists in this draft, so nothing but the health endpoint consults the live color.
- Module manifests that declare supported release ranges and the event versions they read.
- Validation of a configuration import against the releases the target runs.
