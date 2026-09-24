export interface SseUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface SseEvent {
  text?: string;
  finishReason?: string;
  usage?: SseUsage;
  modelVersion?: string;
  responseId?: string;
  raw?: unknown;
}

/**
 * Pure incremental SSE decoder.
 *
 * Handles:
 * - One SSE event split across arbitrary network chunks
 * - Multiple SSE events in one network chunk
 * - CRLF framing (\r\n, \n, \r)
 * - Partial UTF-8 / network boundaries
 * - Malformed JSON without corrupting subsequent parser state
 * - Terminal finishReason
 * - Usage metadata
 *
 * Does not know about Pi APIs.
 */
export class SseDecoder {
  private buffer = "";
  private readonly textDecoder = new TextDecoder("utf-8");
  private currentDataLines: string[] = [];

  /**
   * Feed a chunk (string or Uint8Array) into the decoder.
   * Returns parsed events for all completed SSE event blocks.
   */
  feed(chunk: string | Uint8Array): SseEvent[] {
    const text =
      typeof chunk === "string"
        ? chunk
        : this.textDecoder.decode(chunk, { stream: true });
    this.buffer += text;

    const events: SseEvent[] = [];
    let pos = 0;

    while (pos < this.buffer.length) {
      const lf = this.buffer.indexOf("\n", pos);
      const cr = this.buffer.indexOf("\r", pos);

      let lineEnd = -1;
      let nextPos = -1;

      if (lf !== -1 && (cr === -1 || lf < cr)) {
        lineEnd = lf;
        nextPos = lf + 1;
      } else if (cr !== -1) {
        if (cr === this.buffer.length - 1) {
          // '\r' is at the very end of buffer; could be followed by '\n' in next chunk
          break;
        }
        if (this.buffer[cr + 1] === "\n") {
          lineEnd = cr;
          nextPos = cr + 2;
        } else {
          lineEnd = cr;
          nextPos = cr + 1;
        }
      } else {
        break;
      }

      const line = this.buffer.slice(pos, lineEnd);
      pos = nextPos;

      if (line === "") {
        if (this.currentDataLines.length > 0) {
          const dataStr = this.currentDataLines.join("\n");
          this.currentDataLines = [];
          const event = this.parseData(dataStr);
          if (event) {
            events.push(event);
          }
        }
      } else if (line.startsWith("data:")) {
        let dataValue = line.slice(5);
        if (dataValue.startsWith(" ")) {
          dataValue = dataValue.slice(1);
        }
        this.currentDataLines.push(dataValue);
      }
      // Comments (':') or other fields ('event:', 'id:') are ignored
    }

    this.buffer = this.buffer.slice(pos);
    return events;
  }

  /**
   * Flush remaining buffered data at end of stream.
   */
  flush(): SseEvent[] {
    const remainingText = this.textDecoder.decode();
    if (remainingText) {
      this.buffer += remainingText;
    }

    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      let line = this.buffer;
      if (line.endsWith("\r") || line.endsWith("\n")) {
        line = line.replace(/[\r\n]+$/, "");
      }
      if (line.startsWith("data:")) {
        let dataValue = line.slice(5);
        if (dataValue.startsWith(" ")) {
          dataValue = dataValue.slice(1);
        }
        this.currentDataLines.push(dataValue);
      }
      this.buffer = "";
    }

    if (this.currentDataLines.length > 0) {
      const dataStr = this.currentDataLines.join("\n");
      this.currentDataLines = [];
      const event = this.parseData(dataStr);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  private parseData(dataStr: string): SseEvent | null {
    const trimmed = dataStr.trim();
    if (!trimmed || trimmed === "[DONE]") {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      // Malformed JSON is safely dropped without corrupting state
      return null;
    }

    return extractSseEvent(parsed);
  }
}

/**
 * Extract Cloud Code candidate text, finish reason, and usage from a parsed JSON payload.
 */
export function extractSseEvent(json: unknown): SseEvent | null {
  if (!json || typeof json !== "object") {
    return null;
  }

  const record = json as Record<string, unknown>;
  const response =
    record.response && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : record;

  let text: string | undefined;
  let finishReason: string | undefined;

  const candidates = response.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const candidate = candidates[0] as Record<string, unknown>;

    if (typeof candidate.finishReason === "string") {
      finishReason = candidate.finishReason;
    }

    const content = candidate.content as Record<string, unknown> | undefined;
    if (content && Array.isArray(content.parts)) {
      const textParts: string[] = [];
      for (const part of content.parts) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const p = part as Record<string, unknown>;
        // For V0.1, ignore parts where thought == true
        if (p.thought === true) {
          continue;
        }
        if (typeof p.text === "string" && p.text.length > 0) {
          textParts.push(p.text);
        }
      }
      if (textParts.length > 0) {
        text = textParts.join("");
      }
    }
  }

  let usage: SseUsage | undefined;
  if (response.usageMetadata && typeof response.usageMetadata === "object") {
    const u = response.usageMetadata as Record<string, unknown>;
    usage = {
      promptTokenCount:
        typeof u.promptTokenCount === "number" ? u.promptTokenCount : undefined,
      candidatesTokenCount:
        typeof u.candidatesTokenCount === "number"
          ? u.candidatesTokenCount
          : undefined,
      totalTokenCount:
        typeof u.totalTokenCount === "number" ? u.totalTokenCount : undefined,
      thoughtsTokenCount:
        typeof u.thoughtsTokenCount === "number"
          ? u.thoughtsTokenCount
          : undefined,
    };
  }

  return {
    text,
    finishReason,
    usage,
    modelVersion:
      typeof response.modelVersion === "string"
        ? response.modelVersion
        : undefined,
    responseId:
      typeof response.responseId === "string" ? response.responseId : undefined,
    raw: json,
  };
}
