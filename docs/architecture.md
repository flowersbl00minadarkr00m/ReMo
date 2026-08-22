# ReMo architecture

ReMo has two intentionally separate web compositions.

## Local application

The local application pairs a React interface with a Node.js loopback service. The service owns local SQLite state, content-addressed evidence, source inspection, verification adapters, and the bounded Git worktree operation used to explore an alternate future.

A durable save point correlates:

- source and lineage identity;
- privacy-cleared screenshots and bounded replay evidence;
- contemporaneous human decisions and uncertainty;
- verification, integrity, fidelity, and lifecycle state.

Promotion is explicit. If source authority, evidence identity, privacy checks, or verification do not agree, ReMo fails closed rather than creating a trustworthy-looking record from mismatched inputs.

## Hosted demonstration

The hosted build is selected at compile time and contains no fallback into the local application. It reads one immutable, manifest-bound synthetic fixture through in-memory adapters and a same-origin replay runtime.

```text
Static hosted build
  -> validated synthetic fixture
  -> history, replay, decisions, and comparison
  -> explicitly simulated branch state
```

It cannot perform Git, filesystem, SQLite, capture, service, or persistent operations. The original and alternate futures in the demo are fixed projections used to explain the workflow.

## Repository layout

- `apps/web/` — React interface, hosted composition, and replay surfaces
- `apps/service/` — loopback service and local application orchestration
- `packages/domain/` — shared contracts and validators
- `packages/storage-local/` — local durable state and evidence storage
- `packages/branch-git/` — bounded Git branch/worktree adapter
- `packages/capture-playwright/` — privacy-bounded browser capture
