import { Schema } from "effect";

/**
 * Node or title resolution exceeded its wall-clock budget.
 * Construct with {@link timeoutError} so the message stays consistent.
 */
export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("TimeoutError", {
  timeoutMs: Schema.Number,
  message: Schema.String,
}) {}

/** The run was cancelled by the orchestrator or an abort signal. */
export class CancelledError extends Schema.TaggedErrorClass<CancelledError>()("CancelledError", {
  message: Schema.String,
}) {}

export function timeoutError(timeoutMs: number): TimeoutError {
  return new TimeoutError({
    timeoutMs,
    message: `Timed out after ${timeoutMs}ms`,
  });
}

export function cancelledError(message = "Workflow run was cancelled"): CancelledError {
  return new CancelledError({ message });
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return (
    error instanceof TimeoutError ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: unknown })._tag === "TimeoutError" &&
      "timeoutMs" in error)
  );
}

export function isCancelledError(error: unknown): error is CancelledError {
  return (
    error instanceof CancelledError ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: unknown })._tag === "CancelledError")
  );
}

export function isAbortLikeError(error: unknown): boolean {
  return isCancelledError(error) || (error instanceof Error && error.name === "AbortError");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { _tag: string })._tag);
  }
  return String(error);
}
