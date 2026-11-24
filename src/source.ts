import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const limit = z.number().int().min(1).max(20).default(5);
export class SourceError extends Error {}

export class PublicSource {
  private readonly upstream: typeof fetch;
  constructor(upstream: typeof fetch) {
    this.upstream = upstream;
  }

  async text(url: URL | string, ttl = 300): Promise<string> {
    const init = {
      signal: AbortSignal.timeout(12000),
      redirect: "manual",
      cf: { cacheEverything: ttl > 0, cacheTtlByStatus: { "200-299": ttl, "400-599": -1 } },
    } satisfies RequestInit;
    const fetchFromPlatform = this.upstream;
    const response = await fetchFromPlatform(url, init);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new SourceError(
        "Source returned HTTP " + response.status + ". Check the identifier or retry later."
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let body = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return body + decoder.decode();
        size += chunk.value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new SourceError("Source response exceeded the size limit.");
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  }

  async json<T>(url: URL, schema: z.ZodType<T>, ttl?: number): Promise<T> {
    const value = JSON.parse(await this.text(url, ttl));
    return schema.parse(value);
  }
}

export async function result(
  read: () => Promise<Record<string, unknown>>
): Promise<CallToolResult> {
  try {
    const data = await read();
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    let message = "The source connection failed. Retry later.";
    if (error instanceof SourceError) message = error.message;
    else if (error instanceof z.ZodError || error instanceof SyntaxError)
      message = "The source returned an unexpected data format.";
    else if (error instanceof Error && error.name === "TimeoutError")
      message = "The source timed out. Retry later.";
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
