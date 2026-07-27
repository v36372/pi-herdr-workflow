# Diagnose a workflow run

Disclosed reference for the **workflow** skill's diagnose branch. Artifacts beat guesses.

## Locate the bundle

Default root: `~/.pi/agent/workflows/runs/<runId>/`.

The `workflow` tool result and errors include `runDir`. Inside:

| Path | Read for |
|---|---|
| `manifest.json` | Run identity, status, path map |
| `state.json` | Full `WorkflowRunState`: status, outputs, results, steps, error, waitingOn |
| `trace.ndjson` | Ordered events (`run_*`, `node_*`, `agent_prompt_sent`, …) |
| `workflow.json` | Definition snapshot used for the run |
| `agents/<nodeId>/<attemptId>/task.md` | Exact prompt delivered (role + skills + contract) |
| `agents/<nodeId>/<attemptId>/result.json` | Last `workflow_done` payload (absent if never written) |

## Status → next move

| `state.status` | Meaning | Next move |
|---|---|---|
| `completed` | Graph finished | Inspect `finalOutput` / `outputs` |
| `waiting` | Hit a checkpoint | Read `waitingOn` + checkpoint output; new run after human decision |
| `failed` | Unrouted node failure | Open failing step in `steps` / `results`; see below |
| `timed_out` | Node or title timeout | Check `timeoutMs`, hung agent, or missing `workflow_done` |
| `cancelled` | Abort / `/workflow cancel` | Confirm intent; rerun if needed |
| `running` | Still in flight | Watch tool progress; `/workflow pause\|resume\|cancel` |

## Failure fingerprints

Work from the latest `results[nodeId]` and matching attempt artifacts.

| Fingerprint | Likely cause | Fix |
|---|---|---|
| No `result.json` after settle | Child never called `workflow_done` | Tighten prompt/contract; ensure `workflow_done` is available (executor adds it to `--tools`) |
| `Agent output rejected after N submission(s)` | `validate` never accepted | Read rejection text; fix prompt/`expectedOutput`/`validate` — keep the contract honest |
| `Skill "…" was not found` / `Agent "…" was not found` | Bad `spawn.skills` / `spawn.agent` | Fix names or install the agent markdown / skill under the child cwd |
| `settled without calling workflow_done` | Idle/done without write | Same as missing result; check `task.md` for a clear contract |
| `agent_prompt_stalled` / `agent_not_running` | Pane blocked, dead, or not accepting input | Inspect the pane; resolve approvals; ensure Herdr ≥ 0.7.5 and `HERDR_ENV=1` |
| `protocol_mismatch` | Herdr CLI/server skew | Upgrade Herdr / this package together |
| Switch / missing case errors | Edge cases incomplete | Cover every decision choice and every `$result.outcome` you route |
| `Workflow exceeded maxSteps` | Cycle without exit | Fix edges or raise `maxSteps` only with a clear loop bound |
| `HERDR_ENV` / not inside Herdr | Orchestrator outside Herdr | Rerun from a Herdr-managed pi session |

## Validation retries

On reject, the executor clears `result.json` and re-prompts the same live agent with the validation error (default max 3). A stale accepted payload cannot linger.

If retries exhaust: either the model cannot satisfy the contract (clarify `expectedOutput` / prompt evidence) or `validate` is wrong (fix the predicate, keep required fields).

## Pause / cancel

- `/workflow pause` — finish current node, hold before the next
- `/workflow resume` — release the hold
- `/workflow cancel` — abort active work

Pause never interrupts mid-node; cancel does.

## Confirm the fix

After editing the workflow file:

1. Rerun `/workflow <name>` (or the `workflow` tool) with the same input that failed.
2. Confirm the previously failing node’s `results[nodeId].outcome` is `ok` (or the designed repair/waiting path).
3. Confirm `finalOutput` matches the locked contract from authoring step 1.

**Done when:** the new run’s `state.json` shows the intended terminal status and every agent step that should have succeeded has an accepted `result.json` under its latest attempt.
