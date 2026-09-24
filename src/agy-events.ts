import { StringDecoder } from "node:string_decoder";

export interface AgyInitEvent {
  event: "init";
  timestamp?: string;
  conversation_id: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface AgyStepUpdateUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  thinking_tokens?: number;
  [key: string]: unknown;
}

export interface AgyStepUpdatePayload {
  role?: string;
  content?: string;
  status?: "RUNNING" | "DONE" | string;
  text_delta?: string;
  usage?: AgyStepUpdateUsage;
  [key: string]: unknown;
}

export interface AgyStepUpdateEvent {
  event: "step_update";
  timestamp?: string;
  step_update: AgyStepUpdatePayload;
  [key: string]: unknown;
}

export interface AgyResultPayload {
  status?: "SUCCESS" | "ERROR" | string;
  error?: string;
  conversation_id?: string;
  stop_reason?: string;
  [key: string]: unknown;
}

export interface AgyResultData {
  conversation_id?: string;
  stop_reason?: string;
  [key: string]: unknown;
}

export interface AgyResultEvent {
  event: "result";
  timestamp?: string;
  status?: "SUCCESS" | "ERROR" | string;
  error?: string;
  result?: AgyResultPayload;
  data?: AgyResultData;
  [key: string]: unknown;
}

export type AgyEvent =
  | AgyInitEvent
  | AgyStepUpdateEvent
  | AgyResultEvent
  | { event: string; [key: string]: unknown };

/**
 * Incremental NDJSON event decoder for official AGY stream-json stdout.
 *
 * Tolerates chunk fragmentation, arbitrary byte boundaries, CRLF/LF line
 * endings, multibyte UTF-8 splits, and malformed lines without corrupting
 * subsequent parser state.
 */
export class AgyEventDecoder {
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  feed(chunk: Buffer | string): AgyEvent[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.buffer += text;
    return this.extractEvents();
  }

  flush(): AgyEvent[] {
    this.buffer += this.decoder.end();
    const events = this.extractEvents();
    if (this.buffer.trim().length > 0) {
      try {
        const parsed = JSON.parse(this.buffer.trim());
        if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
          events.push(parsed as AgyEvent);
        }
      } catch {
        // Skip malformed trailing data
      }
      this.buffer = "";
    }
    return events;
  }

  private extractEvents(): AgyEvent[] {
    const events: AgyEvent[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      line = line.trim();
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
          events.push(parsed as AgyEvent);
        }
      } catch {
        // Skip malformed line without corrupting subsequent parser state
      }
    }
    return events;
  }
}
