import { StringDecoder } from "node:string_decoder";

export interface AgyInitEvent {
  event: "init";
  timestamp?: string;
  conversation_id: string;
  session_id?: string;
  [key: string]: unknown;
}

export type AgyStepType =
  | "agent_response"
  | "tool"
  | "subagent"
  | "system_message"
  | "user_input"
  | (string & {});

export type AgyStepState = "ACTIVE" | "DONE" | "RUNNING" | (string & {});

export interface AgyToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  [key: string]: unknown;
}

export interface AgySubagentItem {
  type_name?: string;
  role?: string;
  initial_prompt?: string;
  conversation_id?: string;
  log_uri?: string;
  [key: string]: unknown;
}

export interface AgySubagentInfo {
  subagents?: AgySubagentItem[];
  [key: string]: unknown;
}

export interface AgyStepUpdateUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  [key: string]: unknown;
}

export interface AgyStepUpdatePayload {
  step_index?: number;
  step_type?: AgyStepType;
  state?: AgyStepState;
  conversation_id?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: AgyToolInfo;
  subagent_info?: AgySubagentInfo;
  duration_seconds?: number;
  usage?: AgyStepUpdateUsage;
  // Legacy / fallback fields
  role?: string;
  content?: string;
  status?: "RUNNING" | "DONE" | string;
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
  usage?: AgyStepUpdateUsage;
  [key: string]: unknown;
}

export interface AgyResultData {
  conversation_id?: string;
  stop_reason?: string;
  usage?: AgyStepUpdateUsage;
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

export const DEFAULT_MAX_RECORD_SIZE = 4 * 1024 * 1024; // 4 MB

/**
 * Incremental NDJSON event decoder for official AGY stream-json stdout.
 *
 * Tolerates chunk fragmentation, arbitrary byte boundaries, CRLF/LF line
 * endings, multibyte UTF-8 splits, and malformed lines without corrupting
 * subsequent parser state.
 *
 * Enforces a conservative maximum buffer size to prevent memory exhaustion
 * from unbounded non-newline streams.
 */
export class AgyEventDecoder {
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  readonly maxRecordSize: number;

  constructor(maxRecordSize = DEFAULT_MAX_RECORD_SIZE) {
    this.maxRecordSize = maxRecordSize;
  }

  feed(chunk: Buffer | string): AgyEvent[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.buffer += text;

    if (this.buffer.length > this.maxRecordSize && this.buffer.indexOf("\n") === -1) {
      this.buffer = "";
      throw new Error(
        `NDJSON buffer limit exceeded (${this.maxRecordSize} bytes) without valid line delimiter`,
      );
    }

    return this.extractEvents();
  }

  flush(): AgyEvent[] {
    this.buffer += this.decoder.end();

    if (this.buffer.length > this.maxRecordSize) {
      this.buffer = "";
      throw new Error(
        `NDJSON buffer limit exceeded (${this.maxRecordSize} bytes) without valid line delimiter`,
      );
    }

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
      if (newlineIndex > this.maxRecordSize) {
        this.buffer = "";
        throw new Error(
          `NDJSON record size exceeded limit of ${this.maxRecordSize} bytes`,
        );
      }

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

    if (this.buffer.length > this.maxRecordSize) {
      this.buffer = "";
      throw new Error(
        `NDJSON buffer limit exceeded (${this.maxRecordSize} bytes) without valid line delimiter`,
      );
    }

    return events;
  }
}
