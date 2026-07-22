/**
 * Child-pane extension loaded into each agent node.
 *
 * `workflow_done` writes structured output to result.json. The child is an
 * interactive pi started by Herdr's agent facade; terminating this tool batch
 * settles the agent so `herdr agent prompt --wait` returns to the orchestrator.
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
        throw new Error(
          "PI_WORKFLOW_RESULT_PATH is not set. workflow_done only works inside a Herdr-dispatched workflow agent.",
        );
      }

      writeResultFile(resultPath, {
        runId,
        nodeId,
        attemptId,
        output: params.output,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Workflow step ${nodeId || "(unknown)"} output written to result.json.`,
          },
        ],
        details: { resultPath },
        terminate: true,
      };
    },
  });
}
