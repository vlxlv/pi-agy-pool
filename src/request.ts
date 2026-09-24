import type { Message, TranscriptContext } from "@earendil-works/pi-ai";

export interface CloudCodePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
}

export interface CloudCodeContent {
  role: "user" | "model";
  parts: { text: string }[];
}

export interface CloudCodeSystemInstruction {
  role: "user";
  parts: [{ text: string }];
}

export interface CloudCodeRequestBody {
  systemInstruction?: CloudCodeSystemInstruction;
  contents: CloudCodeContent[];
}

export interface CloudCodePaRequest {
  model: string;
  request: CloudCodeRequestBody;
}

/**
 * Extract plain text from string or message content parts.
 */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(
            part &&
              typeof part === "object" &&
              (part as { type?: unknown }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string",
          ),
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/**
 * Pure conversion logic: Pi Context -> Cloud Code PA JSON request.
 * Does not perform any HTTP requests.
 */
export function buildCloudCodeRequest(
  modelId: string,
  context: { messages: Message[] } | TranscriptContext,
): CloudCodePaRequest {
  let systemPrompt = "";
  const contents: CloudCodeContent[] = [];

  for (const message of context.messages) {
    if (message.role === "system") {
      const text = extractTextContent(message.content);
      if (text) {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      }
      continue;
    }

    if (message.role === "user") {
      const text = extractTextContent(message.content);
      contents.push({
        role: "user",
        parts: [{ text }],
      });
      continue;
    }

    if (message.role === "assistant") {
      const text = extractTextContent(message.content);
      contents.push({
        role: "model",
        parts: [{ text }],
      });
      continue;
    }
  }

  // Support explicit systemPrompt property if present on context
  if (!systemPrompt && typeof (context as Record<string, unknown>).systemPrompt === "string") {
    systemPrompt = (context as Record<string, unknown>).systemPrompt as string;
  }

  const requestBody: CloudCodeRequestBody = {
    contents,
  };

  if (systemPrompt.trim().length > 0) {
    requestBody.systemInstruction = {
      role: "user",
      parts: [{ text: systemPrompt.trim() }],
    };
  }

  return {
    model: modelId,
    request: requestBody,
  };
}
