import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type TranscriptContext,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { buildCloudCodeRequest } from "./request.ts";
import { type SseEvent, SseDecoder } from "./sse.ts";

/**
 * Executes a streaming text-generation request against agy-pool-go.
 *
 * Responsibilities:
 * - fetch dispatch (one single request, no retries/failover)
 * - AbortSignal cancellation
 * - HTTP status and JSON error handling
 * - SSE incremental consumption
 * - Emitting Pi AssistantMessageEventStream events: start, text_delta, done, error
 */
export function streamSimple(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  function handleEvents(events: SseEvent[]): void {
    for (const event of events) {
      if (event.responseId && !output.responseId) {
        output.responseId = event.responseId;
      }
      if (event.modelVersion && !output.responseModel) {
        output.responseModel = event.modelVersion;
      }

      if (event.text) {
        if (output.content.length === 0) {
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
        }
        (output.content[0] as TextContent).text += event.text;
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: event.text,
          partial: output,
        });
      }

      if (event.usage) {
        if (event.usage.promptTokenCount !== undefined) {
          output.usage.input = event.usage.promptTokenCount;
        }
        if (event.usage.candidatesTokenCount !== undefined) {
          output.usage.output = event.usage.candidatesTokenCount;
        }
        if (event.usage.totalTokenCount !== undefined) {
          output.usage.totalTokens = event.usage.totalTokenCount;
        }
        if (event.usage.thoughtsTokenCount !== undefined) {
          output.usage.reasoning = event.usage.thoughtsTokenCount;
        }
      }

      if (event.finishReason) {
        output.rawStopReason = event.finishReason;
        if (event.finishReason === "STOP") {
          output.stopReason = "stop";
        } else if (event.finishReason === "MAX_TOKENS") {
          output.stopReason = "length";
        } else {
          output.stopReason = "stop";
        }
      }
    }
  }

  (async () => {
    try {
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      let payload = buildCloudCodeRequest(model.id, context);
      if (options?.onPayload) {
        const replacement = await options.onPayload(payload, model);
        if (replacement !== undefined) {
          payload = replacement as typeof payload;
        }
      }

      const baseUrl =
        ((model as unknown as Record<string, unknown>).baseUrl as string | undefined) ||
        process.env.AGY_POOL_BASE_URL ||
        "http://127.0.0.1:8899";
      const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1internal:streamGenerateContent?alt=sse`;

      const fetchFn = options?.fetch ?? globalThis.fetch;
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
        signal: options?.signal,
      });

      if (options?.onResponse) {
        const headersRecord: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headersRecord[k] = v;
        });
        await options.onResponse(
          { status: response.status, headers: headersRecord },
          model,
        );
      }

      if (!response.ok) {
        let errorDetail = `HTTP ${response.status} ${response.statusText}`;
        try {
          const errorText = await response.text();
          try {
            const errorJson = JSON.parse(errorText);
            if (errorJson?.error?.message) {
              errorDetail = `HTTP ${response.status}: ${errorJson.error.message}`;
            } else if (errorText) {
              errorDetail = `HTTP ${response.status}: ${errorText}`;
            }
          } catch {
            if (errorText) {
              errorDetail = `HTTP ${response.status}: ${errorText}`;
            }
          }
        } catch {
          // ignore error reading body
        }
        throw new Error(errorDetail);
      }

      stream.push({ type: "start", partial: output });

      const decoder = new SseDecoder();

      if (
        response.body &&
        typeof (response.body as unknown as { getReader: unknown }).getReader ===
          "function"
      ) {
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            const events = done ? decoder.flush() : decoder.feed(value!);
            handleEvents(events);
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      } else if (response.body && Symbol.asyncIterator in Object(response.body)) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array | string>) {
          const events = decoder.feed(chunk);
          handleEvents(events);
        }
        const events = decoder.flush();
        handleEvents(events);
      } else {
        throw new Error("Response body is not readable");
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.content.length > 0 && output.content[0].type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: output.content[0].text,
          partial: output,
        });
      }

      const finalReason =
        output.stopReason === "stop" || output.stopReason === "length"
          ? output.stopReason
          : "stop";
      stream.push({ type: "done", reason: finalReason, message: output });
      stream.end();
    } catch (error) {
      const isAborted =
        Boolean(options?.signal?.aborted) ||
        (error instanceof Error && error.name === "AbortError");
      output.stopReason = isAborted ? "aborted" : "error";
      output.errorMessage =
        isAborted
          ? "Request was aborted"
          : error instanceof Error
            ? error.message
            : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
