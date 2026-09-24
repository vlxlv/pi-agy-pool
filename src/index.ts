import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgyPoolProvider } from "./provider.ts";

/**
 * Pi extension entry point.
 */
export default function (pi: ExtensionAPI): void {
  registerAgyPoolProvider(pi);
}

export * from "./models.ts";
export * from "./provider.ts";
export * from "./request.ts";
export * from "./sse.ts";
export * from "./stream.ts";
