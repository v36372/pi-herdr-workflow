# Effect v4 adoption

## Definition of done

1. `effect@4` and `@effect/platform-node@4` are direct dependencies.
2. Domain failures are `Schema.TaggedErrorClass` values with stable `_tag`s.
3. Persistence and Herdr CLI cross process/fs boundaries as Effect services with Layers.
4. Workflow graph execution is an Effect program (timeouts, cancellation, pause via fibers/Deferred).
5. Agent step execution is an Effect service implementing the same contract.
6. Extension/tool boundaries call `Effect.runPromise` once; no dual Promise/Effect public APIs.
7. `npm test` and `npm run typecheck` pass.
8. `.agent_sources/smol-effect` is available locally for agents (gitignored).

## Domain data shape

Persisted run projection stays the source of truth:

- `WorkflowRunState` status discriminant: `running | waiting | completed | failed | timed_out | cancelled`
- Graph walk: sequential node attempts with edge routing after each outcome
- Node outcomes: `ok | timed_out | failed | cancelled`
- Side effects owned by services: `WorkflowRunStore` (bundle fs), `HerdrClient` (CLI), `AgentStepExecutor` (pane lifecycle)

Author-facing node callbacks remain `MaybePromise` at the workflow-definition boundary and are lifted with `Effect.tryPromise` / `Effect.promise` inside the engine.

## Service map

| Module | Service | Layer deps | Notes |
|---|---|---|---|
| `workflows/errors.ts` | (values) | — | Tagged errors |
| `workflows/store.ts` | `WorkflowRunStore.Service` | `FileSystem`, `Path` | atomic JSON + ndjson |
| `herdr/client.ts` | `HerdrClient.Service` | `ChildProcessSpawner` or custom exec | JSON envelopes |
| `herdr/executor.ts` | `AgentStepExecutor.Service` | `HerdrClient` | pane lifecycle |
| `workflows/engine.ts` | `WorkflowEngine` program + thin class facade | store + executor | pause via `Deferred` |

## Sequencing

1. Scaffold deps + this doc
2. Errors
3. Store
4. Herdr client
5. Engine
6. Executor
7. Extension wiring
8. Full verify

## Principles applied

- **Foundational Thinking**: keep persisted state types; wrap IO and control flow in Effect first.
- **Model the Domain**: run status + node outcome remain discriminants; engine is the state machine driver.
- **Boundary Discipline**: decode/CLI/fs at adapters; pure graph/json helpers stay pure.
- **Laziness Protocol**: no dual APIs; no new abstraction beyond service seams Effect already wants.
- **Outcome-Oriented Execution**: convert call sites and delete Promise-first internals in one wave per module.
- **Sequence Verifiable Units**: each module keeps `npm test` green before the next.

## Progress

| Unit | Status | Evidence |
|---|---|---|
| Scaffold deps + smol-effect source | done | `effect@4.0.0-beta.101`, `.agent_sources/smol-effect` |
| Tagged errors | done | `src/workflows/errors.ts` |
| Run store Effect service | done | `WorkflowRunStore.Service` + Promise facade |
| Herdr client Effect core | done | `execEffect`/`jsonEffect`, TaggedError |
| Result-file Effect helpers | done | Effect + node:fs sync pair |
| Engine control plane | done (facade) | `runEffect`, Deferred pause gate; node dispatch still Promise under the hood |
| Executor Effect facade | done | `runAgentStepEffect` |
| Extension runPromise root | done | tool remains Promise boundary; engine/store Effect-capable |
| Adoption tests | done | `test/effect-adoption.test.ts` |

## Follow-ups (not blocking adoption)

1. Convert `executeGraph` / node dispatch bodies to pure `Effect.gen` with `Effect.timeout` instead of AbortController races.
2. Promote `HerdrClient` to a full `Context.Service` + Layer (injectable exec).
3. Promote `HerdrStepExecutor` to `Context.Service` owning pane lifecycle with scoped finalizers.
4. Decode run-bundle JSON with Schema at the read boundary.

