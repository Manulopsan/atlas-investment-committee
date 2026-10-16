import Anthropic from "@anthropic-ai/sdk";
import type { ModelAdapter, ModelRequest, ModelResponse } from "./adapter";

/**
 * Anthropic adapter (server-only). The API key is read by the SDK from
 * ANTHROPIC_API_KEY in the server environment; it is never sent to the
 * browser, stored in SQLite or written to logs/exports.
 */
export class AnthropicAdapter implements ModelAdapter {
  id = "anthropic";
  kind = "anthropic" as const;
  private client: Anthropic;
  private fallbackEnabled: boolean;

  constructor(opts: { refusalFallback: boolean }) {
    // maxRetries: the SDK retries 408/409/429/5xx and connection errors with backoff.
    this.client = new Anthropic({ maxRetries: 2, timeout: 15 * 60 * 1000 });
    this.fallbackEnabled = opts.refusalFallback;
  }

  async create(req: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.send(req, this.fallbackEnabled);
    } catch (e) {
      // If the account/model rejects the refusal-fallback beta, disable it once and retry.
      if (this.fallbackEnabled && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
        this.fallbackEnabled = false;
        return this.send(req, false);
      }
      throw e;
    }
  }

  private async send(req: ModelRequest, fallback: boolean): Promise<ModelResponse> {
    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      // Stable system prompt first, cached; volatile content lives in messages.
      system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
      messages: req.messages,
      tools: req.tools,
      output_config: { effort: req.effort },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    };
    const stream = this.client.beta.messages.stream(params as Parameters<Anthropic["beta"]["messages"]["stream"]>[0], { signal: req.signal });
    const msg = await stream.finalMessage();
    const u = msg.usage;
    return {
      content: msg.content,
      stopReason: msg.stop_reason,
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      },
      model: msg.model,
      requestId: (msg as unknown as { _request_id?: string })._request_id ?? null,
    };
  }
}
