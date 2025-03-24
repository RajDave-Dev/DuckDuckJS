// deno-lint-ignore no-sloppy-imports
import { ConversationLimitException, DuckDuckGoSearchException, RatelimitException } from "./exceptions.js";
import { DOMParser } from 'linkedom';

// Define supported chat models using a type-safe enum
export const CHAT_MODELS: Record<string, string> = {
  "gpt-4o-mini": "gpt-4o-mini",
  "llama-3.3-70b": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "claude-3-haiku": "claude-3-haiku-20240307",
  "o3-mini": "o3-mini",
  "mistral-small-3": "mistralai/Mistral-Small-24B-Instruct-2501",
};

// Define message structure
export interface Message {
  role: string;
  content: string;
}

/**
 * Represents a search result returned by DuckDuckGo.
 */
export interface SearchResult {
  /** The title of the search result. */
  title: string;
  /** The URL link to the search result. */
  href: string;
  /** The snippet or summary of the search result. */
  body: string;
}

// Class to handle DuckDuckGo chat and search
export class DuckDuck {
  private headers: Record<string, string>;
  private chatVqd: string;
  private chatVqdHash: string;

  constructor() {
    this.headers = { Referer: "https://duckduckgo.com/" };
    this.chatVqd = "";
    this.chatVqdHash = "";
  }

  private async getVqd(): Promise<void> {
    const response = await fetch("https://duckduckgo.com/duckchat/v1/status", {
      method: "GET",
      headers: { "x-vqd-accept": "1" },
    });

    this.chatVqd = response.headers.get("x-vqd-4") || "";
    this.chatVqdHash = response.headers.get("x-vqd-hash-1") || "";

    if (!this.chatVqd || !this.chatVqdHash) throw new Error('Invalid_VQD');
  }

  private async *streamResponse(response: Response): AsyncGenerator<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Failed to read stream');
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const data = line.trim().replace(/^data:\s*/, '');
        if (data === '[DONE]') return;
        if (data === '[DONE][LIMIT_CONVERSATION]') throw new ConversationLimitException('ERR_CONVERSATION_LIMIT');

        try {
          const json = JSON.parse(data);
          if (json.action === 'error') throw new DuckDuckGoSearchException(json.type);
          if (json.message) yield json.message;
        } catch { console.log() }
      }
    }
  }

  private async _textHtml(keywords: string, region: string, timelimit: string | null, maxResults: number | null): Promise<SearchResult[]> {
    const payload: Record<string, string> = { q: keywords, kl: region, ...(timelimit ? { df: timelimit } : {}) };

    const response = await fetch("https://html.duckduckgo.com/html", {
      method: "POST",
      headers: this.headers,
      body: new URLSearchParams(payload),
    });

    if (!response.ok) throw new DuckDuckGoSearchException(`HTML search failed with status ${response.status}`);

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const results: SearchResult[] = [];

    const elements = doc.querySelectorAll("div.result__body");
    for (const e of elements) {
      const link = e.querySelector("a")?.href || "";
      const title = e.querySelector("a")?.textContent || "";
      const body = e.querySelector(".result__snippet")?.textContent || "";
      results.push({ title, href: link, body });
      if (maxResults && results.length >= maxResults) break;
    }
    return results;
  }

  private async _textLite(keywords: string, region: string, timelimit: string | null, maxResults: number | null): Promise<SearchResult[]> {
    const payload: Record<string, string> = { q: keywords, kl: region, ...(timelimit ? { df: timelimit } : {}) };

    const response = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: this.headers,
      body: new URLSearchParams(payload),
    });

    if (!response.ok) throw new DuckDuckGoSearchException(`Lite search failed with status ${response.status}`);

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const results: SearchResult[] = [];

    const elements = doc.querySelectorAll("table:last-of-type tr");
    for (const e of elements) {
      const link = e.querySelector("a")?.href || "";
      const title = e.querySelector("a")?.textContent || "";
      const body = e.querySelector(".result-snippet")?.textContent || "";
      results.push({ title, href: link, body });
      if (maxResults && results.length >= maxResults) break;
    }
    return results;
  }
  
  /**
   * Initiates a chat session with the specified model and streams responses.
   * @param messages - Array of messages representing the conversation.
   * @param model - The chat model to use (default: gpt-4o-mini).
   * @returns AsyncGenerator that yields chat responses as strings.
   * ```ts
   * const duck = new DuckDuck();
   * const messages = [{ role: 'user', content: 'Hello, how are you?' }];
   * for await (const response of duck.chatYield(messages)) {
   *   console.log(response);
   * }
   * ```
   */
  async *chatYield(messages: Message[], model: string = "gpt-4o-mini"): AsyncGenerator<string> {
    if (!this.chatVqd) await this.getVqd();
    if (!CHAT_MODELS[model]) model = "gpt-4o-mini";

    const response = await fetch("https://duckduckgo.com/duckchat/v1/chat", {
      method: "POST",
      headers: {
        ...this.headers,
        "x-vqd-4": this.chatVqd,
        "x-vqd-hash-1": this.chatVqdHash,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: CHAT_MODELS[model], messages }),
    });

    if (response.status === 429) throw new RatelimitException('Ratelimit reached');
    if (!response.ok) throw new DuckDuckGoSearchException(`Request failed with status ${response.status}`);

    this.chatVqd = response.headers.get("x-vqd-4") || "";
    this.chatVqdHash = response.headers.get("x-vqd-hash-1") || "";

    yield* this.streamResponse(response);
  }

  /**
   * Performs a text search using DuckDuckGo with HTML or Lite backends.
   * @param keywords - Search query.
   * @param region - Region for search results (default: wt-wt).
   * @param timelimit - Optional time range filter.
   * @param backend - Preferred backend (auto, html, or lite).
   * @param maxResults - Maximum number of results to return.
   * @returns An array of search results as JSON objects.
   * ```ts
   * const duck = new DuckDuck();
   * const results = await duck.text('AI advancements', 'us-en');
   * console.log(results);
   * ```
   */
  async text(
    keywords: string,
    region: string = "wt-wt",
    timelimit: string | null = null,
    backend: string = "auto",
    maxResults: number | null = null
  ): Promise<SearchResult[]> {
    const backends = backend === "auto" ? ["html", "lite"] : [backend];
    let results: SearchResult[] = [];

    for (const b of backends) {
      try {
        results = b === "html"
          ? await this._textHtml(keywords, region, timelimit, maxResults)
          : await this._textLite(keywords, region, timelimit, maxResults);
        return results;
      } catch (error) {
        console.error(`Error using ${b} backend:`, error);
      }
    }
    throw new DuckDuckGoSearchException("All backends failed.");
  }
}