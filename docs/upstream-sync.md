# Upstream workflow sync

The workflow core tracks [`osolmaz/pi-workflows`](https://github.com/osolmaz/pi-workflows) at v0.2.0, commit `b44db48ea789300fbc791289bb5a46b61f96177a`.

The previous vendor history began around commit `630622e`. Commit `bfe6e4d` predates the first local vendor snapshot, so it is not the effective content baseline.

## Exact upstream files

These files remain byte-for-byte identical to v0.2.0:

- `src/workflows/artifacts.ts`
- `src/workflows/decision.ts`
- `src/workflows/definition.ts`
- `src/workflows/errors.ts`
- `src/workflows/graph.ts`
- `src/workflows/json.ts`
- `src/workflows/shell.ts`
- `src/workflows/text.ts`

Run `npm run check:upstream` to clone the pinned revision and verify them. Pass an existing checkout to avoid cloning:

```bash
bash scripts/check-upstream-workflows.sh /path/to/pi-workflows
```

## Herdr graft files

These upstream files carry the product-specific integration:

- `types.ts` owns the complete authored and resolved spawn data shapes.
- `schema.ts` validates spawn values at the workflow boundary.
- `engine.ts` resolves spawn values and creates per-attempt Herdr protocol paths.
- `store.ts` persists static spawn metadata in workflow snapshots.
- `index.ts` exports the spawn contract.
- `loader.ts` resolves this package name in authored workflows.

A future upstream sync should replace the exact files first, then reapply and review only this graft. The resolved spawn object remains part of every `AgentStepRequest`; it is not executor-local metadata.

## Deliberate boundary

The v0.2.0 run-bundle state, trace, artifacts, schemas, locking, and readers are integrated. The upstream Pi session recorder, terminal renderer, and Rust TUI are not integrated.

Herdr child agents run in separate Pi sessions. Binding the upstream recorder to the orchestrator tool turn would omit the child conversation and finish before the outer tool result, producing a misleading partial replay. Run bundles therefore replay workflow execution, while `agents/<node>/<attempt>/` retains each child task and structured result. Full temporal child-session replay needs a Herdr-aware capture design before it is exposed.
