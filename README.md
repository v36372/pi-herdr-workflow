# pi-herdr-workflows

One package that composes three ideas:

| From | Kept | Dropped |
|---|---|---|
| **pi-workflows** | graph engine, node types, edges, run bundles | graph widget, conversation-step executor, terminal viewer |
| **pi-interactive-subagents** | agent spawn params + result-file protocol | mux tools, `/plan` `/iterate`, status widget, actual dispatch |
| **pi-herdr** | pane/workspace dispatch **and** the `herdr` tool (forked in) | separate package install (disable `~/.pi/agent/extensions/pi-herdr`) |

## What runs where

| Node | Runtime |
|---|---|
| `agent` / `decision` | **Herdr pane** (one pane per attempt, workspace per run) |
| `compute` / `action` / `shell` / `checkpoint` | **Orchestrator process** (main pi) |

Edge routing and validation stay in the engine. Herdr delivers prompts into panes and reports when the agent goes idle; the orchestrator then reads `result.json`.

## Agent spawn params

Same surface as interactive-subagents `subagent()` (minus mux tools):

```ts
agent({
  spawn: {
    name: "Scout: Auth",       // pane label (default: node id)
    agent: "scout",            // load ~/.pi/agent/agents/scout.md defaults
    systemPrompt: "...",       // string or (ctx) => string
    model: "…",
    skills: "foo,bar",
    tools: "read,bash,grep",
    cwd: "./packages/api",     // string or (ctx) => string
    fork: false,
    interactive: false,
  },
  prompt: ({ input, outputs }) => `…`,
  expectedOutput: `{ "findings": [] }`,
  validate: (output) => output,
})
```

## Completion model

`/workflow` blocks on **`workflow_done` → `result.json`** (authoritative). herdr agent-status is only a wake-up so we do not busy-spin.

| Step | action |
|---|---|
| create run workspace | `workspace_create` |
| pane per agent | root pane / `pane_split` |
| start child | `pane run` (`pi -p -ne -e child … @task.md`) |
| wait for finish | poll `result.json`; herdr `wait_agent` as wake-up |
| collect output | accept `result.json` from `workflow_done` |
| show user | durable `pi.sendMessage` (survives `/reload`; not toast-only) |

Per agent attempt under `~/.pi/agent/workflows/runs/<runId>/agents/<nodeId>/<attemptId>/`:

| File | Writer | Purpose |
|---|---|---|
| `task.md` | orchestrator | full prompt |
| `result.json` | child (`workflow_done`) | structured output |
| `launch.sh` | orchestrator | short pane launch script |

Child extension registers `workflow_done` → write `result.json`. Orchestrator unblocks only when that file appears. Launch uses `pi -p` so the process can exit after the tool call. No exit-sidecar handshake.

## Install

```bash
pi install file:./pi-herdr-workflows
# or from this directory after npm i
```

Requires: pi ≥ 0.80, herdr on PATH, running inside a Herdr session for live dispatch.

```bash
/workflow list
/workflow echo summarize this repo
/workflow pause | resume | cancel
```

## Author a workflow

```ts
// .pi/workflows/review.workflow.ts
import { agent, compute, defineWorkflow, decision, decisionEdge } from "pi-herdr-workflows";

export default defineWorkflow({
  name: "review",
  startAt: "scout",
  nodes: {
    scout: agent({
      spawn: { name: "scout", agent: "scout", tools: "read,bash,grep,find,ls" },
      prompt: ({ input }) => `Map the change: ${(input as { task: string }).task}`,
      expectedOutput: `{ "summary": "…", "paths": [] }`,
    }),
    route: decision({
      spawn: { name: "router", model: "…" },
      question: ({ outputs }) => `Risk of: ${JSON.stringify(outputs.scout)}`,
      choices: ["ship", "fix"] as const,
    }),
    note: compute({
      run: ({ outputs }) => ({ decided: outputs.route }),
    }),
  },
  edges: [
    { from: "scout", to: "route" },
    decisionEdge({ from: "route", choices: ["ship", "fix"] as const, cases: { ship: "note", fix: "note" } }),
  ],
});
```

## Library use (no pi extension)

```ts
import { WorkflowEngine, defineWorkflow, agent, HerdrStepExecutor } from "pi-herdr-workflows";

const executor = new HerdrStepExecutor({ cwd: process.cwd() });
const engine = new WorkflowEngine({ executor });
const result = await engine.run(myWorkflow, { task: "…" });
await executor.dispose();
```

Inject a fake `HerdrClient` via `new HerdrClient({ exec })` for tests.

## Herdr tool ownership

This package registers the `herdr` tool (source: `src/herdr/tool.ts`, skill: `skills/herdr/`).
Disable the old install so you do not get two tools:

```bash
mv ~/.pi/agent/extensions/pi-herdr ~/.pi/agent/extensions/pi-herdr.disabled
```

`/workflow` and freeform `herdr` tool calls share the same herdr CLI surface. The slash command drives wait_agent in-process; the model can still call `herdr` for ad-hoc pane work.

## Deliberate ceilings

1. **Agent frontmatter merge** — spawn fields are passed through; full interactive-subagents agent-md resolution (session-mode, auto-exit, deny-tools) is not ported yet. Upgrade: copy their frontmatter loader into `src/herdr/agent-defaults.ts`.
2. **Validation retry in-pane** — if `validate` rejects after the child already exited, the step fails. Upgrade: keep the pane open and `pane run` a reject prompt.
3. **No graph widget / viewer** — run bundles still write to disk; use `state.json` / `trace.ndjson` or reattach a viewer later.
4. **Launch command** — default builds a `pi -e child/extension.ts` line; override with `buildLaunchCommand` for codex/claude/etc.

## Layout

```
src/
  workflows/     # forked engine (no UI)
  herdr/         # client + HerdrStepExecutor + result-file protocol
  child/         # workflow_done extension for agent panes
  extension/     # thin /workflow command (no widget)
```
