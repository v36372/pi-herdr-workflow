# Spawn and API

Disclosed reference for the **workflow** skill. Authoritative types: `src/workflows/types.ts`.

## Definition surface

```ts
import {
  agent, compute, shell, action, checkpoint,
  decision, decisionEdge, defineWorkflow,
} from "pi-herdr-workflows";

export default defineWorkflow({
  name: "review",
  title: ({ input }) => `…`,           // run label
  presentationPrompt: "…",            // post-run presentation instructions
  startAt: "scout",
  nodes: { /* … */ },
  edges: [ /* … */ ],
  maxSteps: 100,                      // optional loop guard
});
```

Node helpers stamp `nodeType` and shape-check at definition time: `agent`, `compute`, `shell`, `action`, `checkpoint`, `decision`.

## Spawn (subagent interface)

Same surface as interactive-subagents `subagent()`, minus mux tools. Set on `agent` / `decision` via `spawn`:

| Field | Role |
|---|---|
| `name` | Pane label (default: node id). String or `(ctx) => string`. |
| `agent` | Load defaults from `.pi/agents/<name>.md`, then `~/.pi/agent/agents/<name>.md`. |
| `systemPrompt` | Appended (or replace via agent frontmatter). String or ctx callback. |
| `model` | `provider/id` override (launch UX can also overlay this). |
| `thinking` | e.g. `low` / `medium` / `high`. |
| `skills` | Eager comma-separated skill names expanded into `<skill>` blocks on the task. |
| `tools` | Comma-separated native tools. Executor always adds `workflow_done`. |
| `cwd` | Child working directory. String or ctx callback. |
| `kind` | `pi` (default) or `pi-wiz` (Wiz MCP env + `pi-mcp-adapter`; Herdr kind still `pi`). |
| `fork` | Full-context fork of the orchestrator session (`pi --fork`). Standalone spawn requires a persisted parent session. |
| `interactive` | Herdr: long waits are collaborative, not stalls. Ignored for standalone subprocess children. |
| `closePaneAfterDone` | Herdr: close the pane after accepted `workflow_done` (default leave open). Ignored for standalone subprocess children. |
| `extensions` | Extra `pi -e` sources on the child. Settings discovery stays disabled (`-ne`). |

Named-agent markdown may set `model`, `thinking`, `tools`, `skill`/`skills`, `cwd`, and `system-prompt: append|replace`. Explicit spawn fields win. Unknown agent or skill fails the node before Pi starts.

## Agent node contract

```ts
agent({
  statusDetail: "Scouting repository",   // progress label
  timeoutMs: 15 * 60_000,                // optional; engine default 15m
  spawn: { name: "scout", tools: "read,bash,grep,find,ls", cwd },
  prompt: ({ input, outputs, results, signal }) => `…`,
  expectedOutput: `{ "summary": "…", "paths": [] }`,
  validate: (output, ctx) => { /* throw or return normalized */ },
})
```

The engine appends a step contract telling the child to call `workflow_done` once with `{"output": …}`. Validation rejection clears `result.json` and re-prompts the same live agent (default ceiling: 3 submissions).

## Decision + edge helpers

```ts
const CHOICES = ["ship", "fix"] as const;

decision({
  spawn: { name: "router", tools: "workflow_done" },
  question: ({ outputs }) => `Risk of: ${JSON.stringify(outputs.scout)}`,
  choices: CHOICES,
  // field?: "route" (default)
})

decisionEdge({
  from: "router",
  choices: CHOICES,
  cases: { ship: "note", fix: "repair" },
})
```

`decision` is an `agent` that validates a closed choice field. Pair it with `decisionEdge` (or any switch on `$.<field>`).

## Switch paths

- `$.field` / `$output.field` — route on accepted node output
- `$result.outcome` — route on `ok` / `failed` / `timed_out` / `cancelled` after a non-ok attempt (repair branches)

## Completion protocol (per attempt)

Under `~/.pi/agent/workflows/runs/<runId>/agents/<nodeId>/<attemptId>/`:

| File | Writer | Role |
|---|---|---|
| `task.md` | orchestrator | Exact submitted prompt (role + skills + contract) |
| `result.json` | child (`workflow_done`) | Authoritative structured output |
| `agent-env.sh` | orchestrator | `PI_WORKFLOW_*` env sourced before agent start |

Child extension registers `workflow_done`, writes `result.json`, returns `terminate: true`. `herdr agent prompt --wait` then wakes the executor.

## Context available to callbacks

`WorkflowNodeContext`: `input`, `outputs` (accepted outputs by node id), `results` (latest full result records), `state`, `signal` (timeout/cancel).

## Library use (no `/workflow`)

```ts
import { WorkflowEngine, HerdrStepExecutor, PiProcessExecutor } from "pi-herdr-workflows";

const executor = process.env.HERDR_ENV === "1"
  ? new HerdrStepExecutor({ cwd: process.cwd() })
  : new PiProcessExecutor({ cwd: process.cwd() });
const engine = new WorkflowEngine({ executor });
const result = await engine.run(myWorkflow, { task: "…" });
await executor.dispose();
```

## Ceilings (design within these)

- Workflow owns lifecycle: agents are fresh ephemeral Pi sessions that finish through `workflow_done`.
- Validation retries stay on the same live agent (`maxValidationAttempts`, default 3).
- Agent kind for workflow nodes is Pi (`pi` / `pi-wiz` wrapper). Other kinds need a compatible structured-result tool.
- Run visibility is pane labels + `workflow` tool progress (no graph widget).
