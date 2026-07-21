import {
  convertToModelMessages,
  type FinishReason,
  isStepCount,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  type ToolSet,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { defineStep } from "../workflow/step.ts";
import { defineWorkflow, type Workflow } from "../workflow/workflow.ts";

export interface AgentConfig {
  name: string;
  /** Model instance or gateway id string like "anthropic/claude-sonnet-4-6". */
  model: LanguageModel;
  instructions?: string;
  /**
   * Tool `execute` functions run as at-least-once workflow steps: a crash
   * between execution and journaling re-runs them on resume, so they must be
   * idempotent. Outputs cross the journal as JSON — they must be JSON-safe
   * (`undefined` becomes `null`).
   */
  tools?: ToolSet;
}

export interface AgentInput {
  messages: UIMessage[];
}

export interface AgentResult {
  text: string;
}

const MAX_MODEL_CALLS = 20;

interface CallModelParams {
  messages: ModelMessage[];
  /** Set on the first call only: the run's message id for the start chunk. */
  startMessageId: string | null;
}

interface AgentToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** Deltas only — the workflow body rebuilds full history from these. */
interface CallModelResult {
  responseMessages: ModelMessage[];
  toolCalls: AgentToolCall[];
  text: string;
  finishReason: FinishReason;
  usage: LanguageModelUsage;
}

type RunToolResult =
  | { ok: true; output: unknown }
  | { ok: false; errorText: string };

/**
 * Wraps an ai-sdk tool loop as a workflow where each model call and each tool
 * call is its own journaled, retryable step — the structure @ai-sdk/workflow
 * uses. Tools are passed to the model without `execute` so streamText never
 * runs them; combined with `stopWhen: isStepCount(1)` each call-model step is
 * exactly one LLM call, and the workflow body executes tools between calls.
 */
export function defineAgent(
  config: AgentConfig,
): Workflow<AgentInput, AgentResult> {
  const tools = config.tools ?? {};
  const clientTools = Object.fromEntries(
    Object.entries(tools).map(([name, { execute, ...tool }]) => [name, tool]),
  );

  const callModel = defineStep(
    `${config.name}:call-model`,
    async (params: CallModelParams, step): Promise<CallModelResult> => {
      const result = streamText({
        model: config.model,
        system: config.instructions,
        messages: params.messages,
        tools: clientTools,
        stopWhen: isStepCount(1),
        // The failure reaches the journal via the awaited promises below and
        // reaches clients as toUIMessageStream's error chunk; the default
        // handler would console.error it a second time.
        onError: () => {},
      });
      // Message-level start is written by hand instead of via sendStart:
      // clients key the assistant message (and its rendered sections) on
      // `messageId`, so it must be unique per run — toUIMessageStream emits
      // a bare `start` with no id.
      if (params.startMessageId !== null) {
        await step.emitChunk({
          type: "start",
          messageId: params.startMessageId,
        });
      }
      await toUIMessageStream({
        stream: result.fullStream,
        tools,
        sendStart: false,
        sendFinish: false,
      }).pipeTo(
        new WritableStream({ write: (chunk) => step.emitChunk(chunk) }),
      );
      return {
        responseMessages: await result.responseMessages,
        toolCalls: (await result.toolCalls).map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })),
        text: await result.text,
        finishReason: await result.finishReason,
        usage: await result.usage,
      };
    },
  );

  const runTool = defineStep(
    `${config.name}:run-tool`,
    async (params: AgentToolCall, step): Promise<RunToolResult> => {
      const tool = tools[params.toolName];
      if (!tool?.execute) {
        const errorText = `Tool "${params.toolName}" is not available`;
        await step.emitChunk({
          type: "tool-output-error",
          toolCallId: params.toolCallId,
          errorText,
        });
        return { ok: false, errorText };
      }
      try {
        // Deliberately minimal execution options: conversation history and
        // tool context are not threaded through the step boundary (journaling
        // them per tool call would duplicate the whole conversation). Tools
        // that read options.messages/options.context get nothing here.
        const output = await tool.execute(params.input as never, {
          toolCallId: params.toolCallId,
          messages: [],
          context: undefined,
        });
        await step.emitChunk({
          type: "tool-output-available",
          toolCallId: params.toolCallId,
          output,
        });
        return { ok: true, output };
      } catch (error) {
        await step.emitChunk({
          type: "tool-output-error",
          toolCallId: params.toolCallId,
          errorText: error instanceof Error ? error.message : String(error),
        });
        // Rethrow so the engine's retry loop drives the attempts; the final
        // failure is caught in the workflow body and fed to the model.
        throw error;
      }
    },
    { maxAttempts: 3 },
  );

  const finishStream = defineStep(
    `${config.name}:finish-stream`,
    async (_: null, step): Promise<null> => {
      // sendFinish is false on every model call (only the last one may
      // finish, and which call is last is unknown mid-stream), so the
      // message-level finish gets its own step — only steps can emit.
      await step.emitChunk({ type: "finish" });
      return null;
    },
  );

  return defineWorkflow(
    config.name,
    async (ctx, input: AgentInput): Promise<AgentResult> => {
      const history = await convertToModelMessages(input.messages);
      let last: CallModelResult;
      for (let call = 0; ; call++) {
        last = await ctx.step(callModel, {
          messages: [...history],
          startMessageId: call === 0 ? ctx.runId : null,
        });
        history.push(...last.responseMessages);
        // At the cap, break before executing pending tools — their results
        // would never be seen by another model call.
        if (last.toolCalls.length === 0 || call + 1 >= MAX_MODEL_CALLS) break;
        history.push({
          role: "tool",
          content: await Promise.all(
            last.toolCalls.map(async (tc) => {
              const result: RunToolResult = await ctx
                .step(runTool, tc)
                .catch((error) => ({
                  ok: false,
                  errorText:
                    error instanceof Error ? error.message : String(error),
                }));
              return {
                type: "tool-result" as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                output: !result.ok
                  ? { type: "error-text" as const, value: result.errorText }
                  : typeof result.output === "string"
                    ? { type: "text" as const, value: result.output }
                    : {
                        type: "json" as const,
                        value: (result.output ?? null) as never,
                      },
              };
            }),
          ),
        });
      }
      await ctx.step(finishStream, null);
      return { text: last.text };
    },
  );
}
