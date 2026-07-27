# Workflow patterns

Disclosed recipes for the **workflow** skill. Runnable sources: `examples/`. Match the user's need to one pattern, then adapt — keep the **contract** and **facts-first** shape.

## Scout (single agent + JSON)

One read-only agent maps a question into structured findings.

- Nodes: `agent` only
- Spawn tools: `read,bash,grep,find,ls` (no writes)
- Contract: `{ summary, paths, risks }` (or domain equivalent)
- Example: `examples/repo-scout.workflow.ts`

Use when the user needs a bounded reconnaissance report, not a multi-step pipeline.

## Facts then judge

Shell (or compute) gathers evidence; an agent judges only that evidence.

- Nodes: `shell` → `agent` → `compute` (pack)
- Prompt the judge with tails of stdout/stderr and exit codes from `outputs`
- Example: `examples/test-then-judge.workflow.ts`

Use when truth is measurable and the model should interpret, not invent, command results.

## Decision ladder

An agent (or prior node) produces material; `decision` picks a closed route; branches rejoin in `compute`.

- Nodes: `agent` → `decision` → branch `compute`s → join `compute`
- Edges: `decisionEdge({ choices, cases })`
- Example: `examples/mood-route.workflow.ts`, `examples/risk-route.workflow.ts`, `examples/coin-flip.workflow.ts`

Use when the graph must fork on a small, named set of outcomes.

## Repair on failure

Happy path plus an explicit `$result.outcome` branch.

```ts
{
  from: "probe",
  switch: {
    on: "$result.outcome",
    cases: { ok: "cleanPack", failed: "repair", timed_out: "repair" },
  },
}
```

- Repair agent reads `results.probe` (full result record), not a fake re-run
- Example: `examples/repair-on-fail.workflow.ts`

Use when failure is expected and should produce a diagnosis rather than abort the run silently.

## Checkpoint gate

Model plans; human approval stops the run as `waiting`.

- Nodes: `agent` → `checkpoint` (no outgoing edge)
- Checkpoint `run` returns what the human should inspect
- Example: `examples/plan-checkpoint.workflow.ts`

Use when the next step is irreversible or policy-bound. Resume is a new run after approval — checkpoints do not continue mid-graph.

## Agent relay

Two or more agent steps in sequence, each with its own contract; a final `compute` packs.

- Keep each agent's tools and prompt scoped to its contract
- Pass prior `outputs` explicitly in the next prompt
- Example: `examples/relay.workflow.ts`

Use when judgment naturally layers (draft → critique → finalize) and each layer needs a separate validation ceiling.

## Pure transform / shell facts

No Herdr panes required for the happy path.

- `compute` only — `examples/hello.workflow.ts`
- `shell` → `compute` — `examples/shell-stats.workflow.ts`

Use when the pipeline is deterministic. Still ship it as a workflow so `/workflow` and run bundles apply.

## Pattern selection

| User need | Pattern |
|---|---|
| "Map this repo / change" | Scout |
| "Did CI / typecheck / tests look healthy?" | Facts then judge |
| "Ship or fix?" / mood / risk labels | Decision ladder |
| "If the probe fails, diagnose" | Repair on failure |
| "Plan, then wait for me" | Checkpoint gate |
| "Draft then review then pack" | Agent relay |
| "Just reshape / run a command" | Pure transform / shell facts |

Compose patterns when needed (scout → decision ladder; shell probe → repair). Prefer the smallest graph that covers the outcome from step 1 of the skill.
