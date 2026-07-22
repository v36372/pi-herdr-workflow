---
name: writing-workflows
description: "Author pi-herdr-workflows graphs. Use when designing or rewriting a workflow, choosing node kinds, wiring edges/decision branches, shaping spawn profiles (agent, tools, skills, model, cwd), or converting multi-step agent work into a durable graph."
---

# Writing Workflows

A workflow is a **deterministic graph**. The orchestrator owns routing and side effects; agent nodes only answer structured prompts through `workflow_done`.

Author against the live API in this package — not against imagined mux/subagent features. Ground facts: `src/workflows/types.ts`, `src/workflows/decision.ts`, `src/herdr/agent-defaults.ts`, `README.md`, `examples/echo.workflow.ts`.

## Authoring steps

1. **Name the outcome**
   Write the final JSON the run must leave in `finalOutput`.
   Done when every field has a producer node and a consumer (or is the terminal result).

2. **Pick node kinds**
   Assign each unit of work the cheapest honest kind:
   - pure reshape / route prep → `compute`
   - local function side effect → `action({ run })`
   - CLI / process → `shell` / `action({ exec })`
   - model judgment → `agent`
   - closed choice among known labels → `decision`
   - human gate → `checkpoint`
   Done when no agent node exists only to format, filter, or shell out.

3. **Draw the spine**
   Linear edges first (`{ from, to }`). Add `switch` / `decisionEdge` only where the next node genuinely depends on a scalar field or `$result.outcome`.
   Done when every node is reachable from `startAt`, every non-terminal non-checkpoint has exactly one outgoing edge, and checkpoints have none.

4. **Shape each agent spawn profile**
   For every `agent` / `decision`, choose the launch envelope before writing prose:
   - identity: `agent` definition and/or `systemPrompt`
   - capability: least-privilege `tools`
   - procedure: eager `skills` only when the full skill body must land in the task
   - placement: `cwd`, `model`
   - label: `name` (pane label; live Herdr name is derived)
   Done when each spawn field has a reason, unknown agent/skill names are verified to exist, and tools cannot do work the step forbids.

5. **Contract the agent I/O**
   Write `prompt`, `expectedOutput`, and `validate` so `workflow_done` can only accept the shape downstream edges/nodes need.
   Done when a bad submission fails validation, and a good one needs no further scraping of free text.

6. **File and run surface**
   Place the module at `.pi/workflows/<name>.workflow.ts` (project) or `~/.pi/agent/workflows/`. Default-export `defineWorkflow(...)`. Name must not be `list|pause|resume|cancel`.
   Done when `/workflow list` would show it and `/workflow <name> …` has a clear input story.

## Runtime map

| Kind | Runtime | Role |
|---|---|---|
| `agent` / `decision` | Herdr pane, fresh ephemeral Pi | Model work; ends via `workflow_done` |
| `compute` | orchestrator | Pure transform |
| `action` (`run`) | orchestrator | Local JS side effect |
| `shell` / `action` (`exec`) | orchestrator child process | Deterministic command |
| `checkpoint` | orchestrator | Pause run as `waiting` |

Edges route after a successful node. Failure routing is opt-in via `$result.*` switches only; otherwise the run fails/cancels/times out.

## Spawn profile

Spawn is a **capability envelope**, not decoration.

```ts
spawn: {
  name: "Scout: Auth",          // pane label
  agent: "scout",               // project `.pi/agents/scout.md` then global
  systemPrompt: "…",            // append (or replace when agent says so)
  model: "provider/model",
  tools: "read,bash,grep,find,ls",
  skills: "code-review",        // eager full-skill expansion into the task
  cwd: "./packages/api",        // string or (ctx) => string
}
```

Resolution rules that change authoring:

- Explicit spawn fields override agent frontmatter.
- Supported agent defaults: `model`, `thinking`, `tools`, `skill`/`skills`, `cwd`, body via `system-prompt: append|replace` (or body prepended to the task when omitted).
- `skills` are **eager**: each named skill is expanded into the submitted task before Pi starts. Missing skill → node fails before launch.
- `tools` is an allowlist. The executor always adds `workflow_done`. Prefer the minimum set that can finish the contract.
- `bash` is not read-only. If the step must not mutate, say so in the prompt **and** avoid write tools; still treat shell as powerful.
- `fork` / `interactive` / agent `session-mode` / `auto-exit` do **not** drive workflow lifecycle today. Children are fresh `--no-session` Pi agents that must call `workflow_done`.

Prefer named `agent` definitions for repeated roles (scout, reviewer, implementer). Prefer inline `systemPrompt` for one-off role glue. Prefer `skills` when a durable procedure should be injected whole; do not list skills “just in case.”

## Node recipes

**Agent** — judgment, synthesis, multi-file reasoning under a tool envelope.

```ts
agent({
  spawn: { name: "scout", agent: "scout", tools: "read,bash,grep,find,ls" },
  prompt: ({ input, outputs }) => `…use prior outputs: ${JSON.stringify(outputs)}…`,
  expectedOutput: `{ "summary": "…", "paths": ["…"] }`,
  validate: (output) => output, // throw to reject
})
```

**Decision** — closed label set + typed switch. Prefer over a freeform agent when routing is the only job.

```ts
decision({
  spawn: { name: "router", tools: "read" },
  question: ({ outputs }) => `Risk of: ${JSON.stringify(outputs.scout)}`,
  choices: ["ship", "fix"] as const,
})
// edges:
decisionEdge({
  from: "route",
  choices: ["ship", "fix"] as const,
  cases: { ship: "finish", fix: "implement" },
})
```

**Compute** — join outputs, drop fields, build the next prompt’s data. Never put this in an agent.

**Shell / action** — tests, formatters, `git` snapshots, deterministic generators. Use `parse` to turn stdout into JSON for later nodes. Observe `context.signal` for long work.

**Checkpoint** — human approval or external resume. Terminal for the graph; no outgoing edge. Output becomes `finalOutput` while status is `waiting`.

## Edges

- Linear: `{ from: "a", to: "b" }`
- Switch on output field: `{ from: "a", switch: { on: "$.route", cases: { ship: "b", fix: "c" } } }`
  also `$output.field`
- Switch on result metadata: `{ switch: { on: "$result.outcome", cases: { failed: "repair", timed_out: "repair" } }`
  Only `$result.*` switches run after failure.

Rules:

- One outgoing edge per node.
- Switch values must be scalar; missing case fails the run.
- Keep branch labels stable strings shared by `decision.choices`, validate, and `cases`.

## Useful combinations

1. **Scout → decision → act**  
   Read-only scout agent → `decision` on risk → either `compute` summary or implementer agent with write tools.

2. **Shell facts → agent judgment**  
   `shell`/`action` gathers exact command output → agent interprets only that evidence (no re-measurement).

3. **Agent → compute → agent**  
   First agent returns raw findings → compute normalizes/whittles → second agent with a tighter spawn profile.

4. **Happy path + `$result.outcome` repair**  
   Main linear spine; failure switch to a repair agent or shell diagnostics, then rejoin or checkpoint.

5. **Checkpoint release train**  
   Plan agent → checkpoint (human) → worker agents. Do not pretend a model approval is a checkpoint.

6. **Role folders**  
   `cwd` into a package/worktree so project skills and local conventions load where the work lives; keep tools scoped to that job.

## Prompt and contract craft

- Put durable procedure in `skills` or agent body; put run-specific data in `prompt`.
- Pass prior nodes via `outputs` / `results`, not by restating the whole run in prose.
- `expectedOutput` is a schema sketch for the model and for humans reading traces; `validate` is the real gate.
- Outputs must be JSON-serializable. Prefer plain objects/arrays/strings/numbers/booleans/null.
- Engine appends the `workflow_done` contract automatically — do not reimplement it in the prompt.

## File skeleton

```ts
// .pi/workflows/review.workflow.ts
import {
  agent, compute, decision, decisionEdge, defineWorkflow, shell,
} from "pi-herdr-workflows";

export default defineWorkflow({
  name: "review",
  title: ({ input }) => `review: ${(input as { task?: string }).task ?? "change"}`,
  startAt: "scout",
  presentationPrompt: "Summarize the decision and cite key paths only.",
  nodes: {
    scout: agent({
      spawn: {
        name: "scout",
        agent: "scout",
        tools: "read,bash,grep,find,ls",
      },
      prompt: ({ input }) => `Map the change: ${(input as { task: string }).task}`,
      expectedOutput: `{ "summary": "…", "paths": [] }`,
    }),
    route: decision({
      spawn: { name: "router", tools: "read" },
      question: ({ outputs }) => `Risk of: ${JSON.stringify(outputs.scout)}`,
      choices: ["ship", "fix"] as const,
    }),
    verify: shell({
      exec: () => ({ command: "npm", args: ["test"] }),
      parse: (result) => ({ ok: result.exitCode === 0, stdout: result.stdout }),
    }),
    note: compute({
      run: ({ outputs }) => ({ scout: outputs.scout, route: outputs.route, verify: outputs.verify }),
    }),
  },
  edges: [
    { from: "scout", to: "route" },
    decisionEdge({
      from: "route",
      choices: ["ship", "fix"] as const,
      cases: { ship: "verify", fix: "note" },
    }),
    { from: "verify", to: "note" },
  ],
});
```

## Anti-patterns

- One giant agent node that scouts, decides, edits, and tests.
- `tools` left wide open “for flexibility.”
- Listing `skills` without needing their full body every run.
- Freeform agent text parsed by later nodes instead of `validate`d JSON.
- Switch on free prose instead of a closed decision field.
- Outgoing edge from a checkpoint.
- Relying on `fork` / interactive subagent lifecycle inside a workflow.
- Workflow names that collide with `/workflow` subcommands.

## Completion checklist

Before shipping a workflow:

- [ ] Final output shape is explicit
- [ ] Each node is the cheapest kind that works
- [ ] Graph validates: reachable nodes, one edge out, checkpoint terminal
- [ ] Every agent has a deliberate spawn profile and JSON contract
- [ ] Decision labels match switch cases exactly
- [ ] Shell/actions observe cancellation where long-running
- [ ] File is discoverable under `.pi/workflows/` and runs via `/workflow <name>`
