import { agent, compute, defineWorkflow, shell } from "pi-herdr-workflows";
import { CHEAP } from "./_cheap.js";

/**
 * Shell measures, agent judges only that evidence.
 *
 * Run: /workflow test-then-judge
 */
export default defineWorkflow({
  name: "test-then-judge",
  title: "test-then-judge",
  startAt: "typecheck",
  presentationPrompt: "State pass/fail and the judge's one-line verdict.",
  nodes: {
    typecheck: shell({
      statusDetail: "Running typecheck",
      exec: () => ({
        command: "npm",
        args: ["run", "typecheck"],
        cwd: process.cwd(),
        allowNonZeroExit: true,
      }),
      parse: (result) => ({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      }),
    }),
    judge: agent({
      statusDetail: "Judging typecheck output",
      spawn: {
        name: "judge",
        ...CHEAP,
        tools: "read",
        cwd: process.cwd(),
      },
      prompt: ({ outputs }) => {
        const tc = outputs.typecheck as {
          exitCode: number | null;
          stdout: string;
          stderr: string;
        };
        return [
          "Judge whether typecheck is healthy.",
          "Use only the shell evidence below. Do not invent command results.",
          "Keep the verdict to one sentence.",
          "",
          `exitCode: ${String(tc.exitCode)}`,
          "--- stdout ---",
          tail(tc.stdout, 4000),
          "--- stderr ---",
          tail(tc.stderr, 2000),
        ].join("\n");
      },
      expectedOutput: `{ "ok": true, "verdict": "one sentence", "blockers": ["…"] }`,
      validate: (output) => {
        const value = asObject(output);
        if (typeof value.ok !== "boolean") throw new Error("ok must be boolean");
        if (typeof value.verdict !== "string" || !value.verdict.trim()) {
          throw new Error("verdict must be a non-empty string");
        }
        if (value.blockers !== undefined && !Array.isArray(value.blockers)) {
          throw new Error("blockers must be an array when present");
        }
        return {
          ok: value.ok,
          verdict: (value.verdict as string).trim(),
          blockers: Array.isArray(value.blockers) ? value.blockers : [],
        };
      },
    }),
    pack: compute({
      run: ({ outputs }) => {
        const tc = outputs.typecheck as {
          exitCode: number | null;
          stdout: string;
          stderr: string;
        };
        const judge = outputs.judge as {
          ok: boolean;
          verdict: string;
          blockers: unknown[];
        };
        return {
          ok: judge.ok,
          verdict: judge.verdict,
          blockers: judge.blockers,
          evidence: {
            exitCode: tc.exitCode,
            stdoutTail: tail(tc.stdout, 500),
            stderrTail: tail(tc.stderr, 500),
          },
        };
      },
    }),
  },
  edges: [
    { from: "typecheck", to: "judge" },
    { from: "judge", to: "pack" },
  ],
});

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

function asObject(output: unknown): Record<string, unknown> {
  if (output == null || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("output must be a JSON object");
  }
  return output as Record<string, unknown>;
}
