import { agent, compute, defineWorkflow, shell } from "pi-herdr-workflows";
import { CHEAP } from "./_cheap.js";

/**
 * Happy path plus `$result.outcome` repair branch.
 *
 * Run: /workflow repair-on-fail
 *      /workflow repair-on-fail {"mode":"fail"}
 */
export default defineWorkflow({
  name: "repair-on-fail",
  title: ({ input }) =>
    `repair-on-fail:${(input as { mode?: string } | null)?.mode ?? "ok"}`,
  startAt: "probe",
  presentationPrompt: "Say whether the path was clean or repaired, and why.",
  nodes: {
    probe: shell({
      statusDetail: "Probing (may fail on purpose)",
      exec: ({ input }) => {
        const mode =
          typeof input === "object" &&
          input !== null &&
          (input as { mode?: unknown }).mode === "fail"
            ? "fail"
            : "ok";
        return {
          command: "bash",
          args: [
            "-lc",
            mode === "fail"
              ? 'echo "probe failed on purpose" 1>&2; exit 1'
              : 'echo "probe ok"',
          ],
          cwd: process.cwd(),
        };
      },
      parse: (result) => ({
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      }),
    }),
    repair: agent({
      statusDetail: "Diagnosing failed probe",
      spawn: {
        name: "repair",
        ...CHEAP,
        tools: "read",
        cwd: process.cwd(),
      },
      prompt: ({ results }) => {
        const probe = results.probe;
        return [
          "The probe shell node failed. Diagnose from the result record only.",
          "Do not re-run the probe. Keep the diagnosis short.",
          "",
          JSON.stringify(probe, null, 2),
          "",
          "Return a short repair plan and whether a retry would help.",
        ].join("\n");
      },
      expectedOutput: `{ "diagnosis": "…", "retry": true, "steps": ["…"] }`,
      validate: (output) => {
        const value = asObject(output);
        if (typeof value.diagnosis !== "string") throw new Error("diagnosis required");
        if (typeof value.retry !== "boolean") throw new Error("retry must be boolean");
        if (!Array.isArray(value.steps)) throw new Error("steps must be an array");
        return value;
      },
    }),
    cleanPack: compute({
      statusDetail: "Packing clean result",
      run: ({ outputs }) => ({
        status: "clean" as const,
        detail: "Probe succeeded; repair path unused.",
        probe: outputs.probe,
      }),
    }),
    repairedPack: compute({
      statusDetail: "Packing repaired result",
      run: ({ outputs, results }) => ({
        status: "repaired" as const,
        detail: "Probe failed; repair agent produced a diagnosis.",
        probe: results.probe,
        repair: outputs.repair,
      }),
    }),
  },
  edges: [
    {
      from: "probe",
      switch: {
        on: "$result.outcome",
        cases: {
          ok: "cleanPack",
          failed: "repair",
          timed_out: "repair",
        },
      },
    },
    { from: "repair", to: "repairedPack" },
  ],
});

function asObject(output: unknown): Record<string, unknown> {
  if (output == null || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("output must be a JSON object");
  }
  return output as Record<string, unknown>;
}
