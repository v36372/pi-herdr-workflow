/**
 * Child-pane extension loaded into each agent node.
 *
 * `workflow_done` writes structured output to result.json. With `pi -p`, the
 * process then ends and herdr reports the pane idle/done — the orchestrator
 * waits via herdr wait_agent / wait agent-status, not an exit sidecar.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeResultFile } from "../herdr/result-file.js";

const WorkflowDoneParams = Type.Object({
  output: Type.Unknown({
    description: "Structured JSON output for this workflow step",
  }),
});

export default function (pi: ExtensionAPI) {
  const runId = process.env.PI_WORKFLOW_RUN_ID ?? "";
  const nodeId = process.env.PI_WORKFLOW_NODE_ID ?? "";
  const attemptId = process.env.PI_WORKFLOW_ATTEMPT_ID ?? "";
  const resultPath = process.env.PI_WORKFLOW_RESULT_PATH ?? "";

  pi.registerTool({
    name: "workflow_done",
    label: "Workflow Done",
    description:
      "Submit the structured output for this workflow step. Call exactly once when the step is complete.",
    parameters: WorkflowDoneParams,
    async execute(_toolCallId, params) {
      if (!resultPath) {
        return {
          content: [
            {
              type: "text" as const,
              text: "PI_WORKFLOW_RESULT_PATH is not set. This tool only works inside a herdr-dispatched workflow agent pane.",
            },
          ],
          details: { resultPath: "" },
          isError: true,
        };
      }

      try {
        writeResultFile(resultPath, {
          runId,
          nodeId,
          attemptId,
          output: params.output,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Failed to write result: ${message}` }],
          details: { resultPath },
          isError: true,
        };
      }

      // Do not call shutdown here. Launch uses `pi -p`, so the process exits
      // after this turn and herdr flips the pane to idle for wait_agent.
      return {
        content: [
          {
            type: "text" as const,
            text: `Workflow step ${nodeId || "(unknown)"} output written to result.json.`,
          },
        ],
        details: { resultPath },
      };
    },
  });
}
