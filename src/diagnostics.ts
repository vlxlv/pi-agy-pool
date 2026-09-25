/** Best-effort credential redaction, not a guarantee for arbitrary secret formats. */
export function sanitizeDiagnostic(text: string): string {
  return text
    .replace(/((?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|session[_-]?token|token|session)\b["']?\s*[:=]\s*["']?)[^\s&;,"'<>]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .slice(0, 4096);
}
