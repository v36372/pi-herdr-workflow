import { compute, defineWorkflow, shell } from "pi-herdr-workflows";

/**
 * Level 7: shell that can fail on `input.mode`, then `$result.outcome` routes
 * to a repair *compute* (not agent) so the graph stays mockable without Herdr.
 *
 * Input:  { mode?: "ok" | "fail" }
 * Output: { status: "clean" | "repaired", ... }
 *
 * Run: /workflow 07-repair-outcome
 *      /workflow 07-repair-outcome {"mode":"fail"}
 */
export default defineWorkflow({
  name: "07-repair-outcome",
  title: ({ input }) =>
    `repair-outcome:${(input as { mode?: string } | null)?.mode ?? "ok"}`,
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
              ? 'printf "%s\\n" "probe failed on purpose" 1>&2; exit 1'
              : 'printf "%s\\n" "probe ok"',
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
    repair: compute({
      statusDetail: "Repairing from failed probe",
      run: ({ results }) => {
        const probe = results.probe;
        return {
          diagnosis: "probe exited non-zero",
          retry: true,
          probeOutcome: probe?.outcome ?? "failed",
          stderr: (probe?.output as { stderr?: string } | undefined)?.stderr ?? "",
        };
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
        detail: "Probe failed; repair compute produced a diagnosis.",
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
