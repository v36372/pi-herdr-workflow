---
name: workflow
description: "Workflow graphs for pi-herdr-workflows. Use when authoring a .workflow.ts multi-step pipeline, diagnosing a failed /workflow run, or choosing a workflow over freeform Herdr agents."
---

# Workflow

A **workflow** is a deterministic graph the orchestrator walks once via the `workflow` tool. Agent nodes spawn through an **agent medium** (Herdr panes, a `pi` subprocess, or a test mock); compute / shell / checkpoint stay in-process. Agents finish through a **contract**: `expectedOutput` + `validate` + `workflow_done` → `result.json`.

Field-level API, recipes, and run-bundle forensics live behind the pointers below — load them when that step needs them.

## Workflow vs freeform Herdr

| Reach for a **workflow** when… | Reach for freeform `herdr_*` tools when… |
|---|---|
| The job is a repeatable pipeline with a known shape | The user is driving live panes interactively |
| Structured JSON must be validated | There is no fixed graph or contract |
| Steps must leave an auditable run bundle | Topology is exploratory, one-off, or human-paced |

For an authored graph, call the `workflow` tool (or have the user run `/workflow <name>`). Freeform pane control stays on `herdr_layout` / `herdr_pane` / `herdr_agent`.

## Author a workflow

### 1. Capture the outcome

Write the run's final JSON shape and one `presentationPrompt` sentence.

**Done when:** every `finalOutput` field is named with a type, and the presentation sentence exists.

### 2. Partition the graph

One job per node. Classify each as `shell` / `compute` / `action` (facts), `agent` (judgment), `decision` (closed route), or `checkpoint` (human gate; may have an outgoing edge for continueRun continuations).

**Done when:** every node has an id, a type, a one-sentence job, and named I/O shapes.

### 3. Facts first

Put measurable work on `shell` / `compute`. Agents receive evidence from `outputs` / `results`.

Load [patterns.md](patterns.md) to pick a recipe (scout, facts-then-judge, decision ladder, repair branch, checkpoint, relay).

**Done when:** every measurable fact has a non-agent owner.

### 4. Lock the contracts

Every `agent` / `decision` gets `expectedOutput` and a `validate` that throws on missing or wrong-typed required fields, then returns the normalized shape.

**Done when:** every agent-backed node has both, and each `validate` rejects empty-object and wrong-type inputs for its required fields.

### 5. Configure spawn

Smallest tool set that can satisfy the contract; human-readable `spawn.name`; scoped `cwd` when the work is bounded.

Load [api.md](api.md) for spawn fields, named-agent defaults, skills expansion, and the `workflow_done` protocol.

**Done when:** every spawn has an explicit tool set, a pane `name`, and a justified `cwd` / `model` / `agent` choice.

### 6. Wire edges

Plain `{ from, to }`, `decisionEdge(...)`, or `$result.outcome` for repair. At most one outgoing edge per node; every node reachable from `startAt`; checkpoints terminal.

**Done when:** the graph satisfies those three invariants (the same checks as `validateWorkflowDefinition`).

### 7. Place and smoke

Default-export `defineWorkflow({...})` from `.pi/workflows/<name>.workflow.ts` (or this package's `examples/` for demos). Import builders from `pi-herdr-workflows`.

Smoke with `/workflow <name>` (Herdr panes when `HERDR_ENV=1`, otherwise a child `pi`). On validation rejects, tighten prompt or evidence — keep `validate` honest.

**Done when:** a run reaches the intended terminal status (`completed`, intentional `waiting`, or the designed repair path) and `state.json` matches the step-1 shapes.

## Diagnose a failed run

Load [debug.md](debug.md). Read the run bundle first; fix the contract, spawn, or edge the artifacts implicate.

## External reference

- Package `README.md` — install, `/workflow` UX, deliberate ceilings
- `examples/` — runnable graph for each pattern
- `src/workflows/types.ts` — TypeScript source of truth
