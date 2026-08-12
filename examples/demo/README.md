# Graded demo workflows

Level 1–8 graphs under `examples/demo/`. File stem = discover / `/workflow` name.

These showcase engine capabilities with increasing complexity. Most levels are compute/shell-only and run without Herdr. Agent levels (04, 08 mid-node) need a live Herdr session or a mocked `AgentStepExecutor` in tests.

| Level | Command | Graph | Shows |
|---|---|---|---|
| 1 | `/workflow 01-compute-pipeline` | compute → compute → compute | Basic graph execution, pure transforms |
| 2 | `/workflow 02-shell-facts` | shell → compute | Deterministic shell facts, then format |
| 3 | `/workflow 03-timeout-budget` | compute (`timeoutMs` fn) | Functional `timeoutMs: (ctx) => number` on a successful fast node |
| 4 | `/workflow 04-spawn-matrix` | agent (full spawn) | Explicit spawn surface; live Herdr for real runs, mock in tests |
| 5 | `/workflow 05-decision-rejoin` | compute → switch → branches → rejoin | Branch/rejoin via switch on compute (deterministic; no `decision()`) |
| 6 | `/workflow 06-checkpoint-continue` | compute → checkpoint → compute | HITL gate with outgoing edge; `continueRun` |
| 7 | `/workflow 07-repair-outcome` | shell → `$result.outcome` → repair compute | Failure routing without Herdr |
| 8 | `/workflow 08-parkable-stages` | stage1 → midAgent → stage2 → stage3 | Multi-stage park/resume target |

## Run

From a Herdr session with this package installed (workflows discovered from `.pi/workflows` or by path):

```bash
/workflow list
/workflow 01-compute-pipeline
/workflow 01-compute-pipeline {"value":"pi-herdr"}
/workflow 02-shell-facts {"label":"build"}
/workflow 03-timeout-budget {"budgetMs":2000,"tag":"fast"}
/workflow 04-spawn-matrix {"echo":"ping"}
/workflow 05-decision-rejoin {"route":"right"}
/workflow 06-checkpoint-continue {"topic":"ship demo"}
/workflow 07-repair-outcome {"mode":"fail"}
/workflow 08-parkable-stages {"seed":"alpha"}
```

Or load by path:

```bash
/workflow examples/demo/01-compute-pipeline.workflow.ts
```

Agent demos need Herdr (`HERDR_ENV=1`). Levels 1–3, 5–7 are Herdr-free on the happy path.

## Engine APIs (06 and 08)

**06 — checkpoint + `continueRun`**

1. `engine.run(workflow, input)` stops at the checkpoint with status `waiting`.
2. `engine.continueRun(workflow, parentRunId, answer)` starts a continuation run that carries checkpoint outputs across the outgoing edge into the next compute node.

**08 — park / resume**

1. While `engine.run(...)` is in flight (often on `midAgent`), call `engine.park()`.
2. The run bundle stays `running` at the current node.
3. `engine.resumeRun(workflow, runId, { workflowHash })` finishes the remaining stages.

## Cheap model

Agent nodes import `CHEAP` from `../_cheap.js` (`openai-codex/gpt-5.6-luna`, `thinking: "low"`).
