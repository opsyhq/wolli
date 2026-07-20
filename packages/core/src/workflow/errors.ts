export class WorkflowCancelledError extends Error {
  constructor(runId: string) {
    super(`Workflow run "${runId}" was cancelled`);
    this.name = "WorkflowCancelledError";
  }
}

export class NonDeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonDeterminismError";
  }
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export function serializeError(error: unknown): string {
  if (error instanceof Error)
    return JSON.stringify({
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  return JSON.stringify({ name: "Error", message: String(error) });
}

export function rehydrateError(json: string): Error {
  const data = JSON.parse(json) as SerializedError;
  const error = new Error(data.message);
  error.name = data.name;
  if (data.stack !== undefined) error.stack = data.stack;
  return error;
}
