# Upstream workflow sync

The workflow core tracks [`osolmaz/pi-workflows`](https://github.com/osolmaz/pi-workflows) at v0.3.0 (`828a30e`), with a selective Herdr graft rather than a full host/controller/viewer import.

Pinned content baseline for unchanged exact files remains the v0.2.0 tree at `b44db48ea789300fbc791289bb5a46b61f96177a`. Files that diverged for durable runs are listed below.

## Exact upstream files

These files remain byte-for-byte identical to the v0.2.0 pin (`b44db48`):

- `src/workflows/artifacts.ts`
- `src/workflows/decision.ts`
- `src/workflows/definition.ts`
- `src/workflows/json.ts`
- `src/workflows/shell.ts`
- `src/workflows/text.ts`

These files match upstream HEAD (`828a30e`) exact content:

- `src/workflows/errors.ts`
- `src/workflows/graph.ts`

Run `npm run check:upstream` to clone the pinned revision and verify the unchanged exact files. Pass an existing checkout to avoid cloning:

```bash
bash scripts/check-upstream-workflows.sh /path/to/pi-workflows
```

## Herdr graft files

These upstream files carry the product-specific integration:

- `types.ts` owns the complete authored and resolved spawn data shapes, plus durable-run state fields (`parentRunId`, `carriedStepCount`, `workflowHash`) and functional `timeoutMs`.
- `schema.ts` validates spawn values and timeout callbacks at the workflow boundary.
- `engine.ts` resolves spawn values, creates per-attempt Herdr protocol paths, and exposes `park` / `resumeRun` / `continueRun`.
- `store.ts` persists static spawn metadata in workflow snapshots and prepares interrupted bundles for resume.
- `index.ts` exports the spawn contract and durable-run helpers.
- `loader.ts` resolves this package name in authored workflows and hashes workflow sources for resume pinning.

A future upstream sync should replace the exact files first, then reapply and review only this graft. The resolved spawn object remains part of every `AgentStepRequest`; it is not executor-local metadata.

## Deliberate boundary

The v0.3.0 run-bundle state, trace, artifacts, schemas, locking, park/resume, checkpoint continuation, and fenced writes are integrated. The upstream Pi session recorder, terminal renderer, Rust TUI, always-on host, controller runtime, and built-in monitor workflow are not integrated.

Herdr child agents run in separate Pi sessions. Binding the upstream recorder to the orchestrator tool turn would omit the child conversation and finish before the outer tool result, producing a misleading partial replay. Run bundles therefore replay workflow execution, while `agents/<node>/<attempt>/` retains each child task and structured result. Full temporal child-session replay needs a Herdr-aware capture design before it is exposed.

Engine aborts (timeout, cancel, park) propagate through the agent-step `AbortSignal`. The Herdr executor interrupts the live child with Escape and kills the waiting CLI process so a closed attempt cannot keep working.
