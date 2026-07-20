import {
  convertToModelMessages,
  type LanguageModel,
  ToolLoopAgent,
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
  tools?: ToolSet;
}

export interface AgentInput {
  messages: UIMessage[];
}

export interface AgentResult {
  text: string;
}

/**
 * Wraps an ai-sdk ToolLoopAgent as a workflow. The whole tool loop runs as
 * one durable step: its UI message chunks stream to the run's stream while
 * they're generated, and only the final text crosses into the journal — the
 * same aggregates-vs-stream split @ai-sdk/workflow's doStreamStep makes.
 */
export function defineAgent(
  config: AgentConfig,
): Workflow<AgentInput, AgentResult> {
  const callAgent = defineStep(
    `${config.name}:call-agent`,
    async ({ messages }: AgentInput, step): Promise<AgentResult> => {
      const agent = new ToolLoopAgent({
        model: config.model,
        instructions: config.instructions,
        tools: config.tools,
      });
      // onError reaches streamText at runtime but is missing from
      // AgentCallParameters in ai@7.0.31, hence the intersection. Without it
      // the default handler console.errors every stream failure — the failure
      // already reaches the journal via the `result.text` rejection below and
      // reaches clients as toUIMessageStream's error chunk.
      const options: Parameters<typeof agent.stream>[0] & {
        onError?: () => void;
      } = {
        messages: await convertToModelMessages(messages),
        onError: () => {},
      };
      const result = await agent.stream(options);
      await toUIMessageStream({
        stream: result.fullStream,
        tools: config.tools,
      }).pipeTo(
        new WritableStream({ write: (chunk) => step.emitChunk(chunk) }),
      );
      return { text: await result.text };
    },
  );
  return defineWorkflow(config.name, (ctx, input: AgentInput) =>
    ctx.step(callAgent, input),
  );
}
