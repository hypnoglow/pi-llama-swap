/**
 * HTTP client for llama-swap OpenAI-compatible API.
 */

import type { OpenAIModelEntry, OpenAIModelsListResponse } from "./types.js";

/** Error thrown when llama-swap API request fails. */
export class LlamaSwapClientError extends Error {
	/** HTTP status when the server responded with an error. */
	readonly status?: number;

	/**
	 * @param message - Human-readable error description.
	 * @param status - Optional HTTP status code.
	 */
	constructor(message: string, status?: number) {
		super(message);
		this.name = "LlamaSwapClientError";
		this.status = status;
	}
}

/**
 * Fetches the model list from llama-swap (`GET {baseUrl}/models`).
 * @param baseUrl - OpenAI API base URL ending in `/v1`.
 * @param apiKey - Optional Bearer token.
 * @param signal - Optional abort signal.
 * @returns Array of model entries from the `data` field.
 * @throws {LlamaSwapClientError} On network or non-2xx responses.
 */
export async function fetchModels(
	baseUrl: string,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<OpenAIModelEntry[]> {
	const url = `${baseUrl.replace(/\/$/, "")}/models`;
	const headers: Record<string, string> = {
		Accept: "application/json",
	};

	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	let response: Response;
	try {
		response = await fetch(url, { method: "GET", headers, signal });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new LlamaSwapClientError(`Cannot reach llama-swap at ${url}: ${msg}`);
	}

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const hint =
			response.status === 401
				? " Set API key via /llama-swap-api-key or LLAMA_SWAP_API_KEY."
				: "";
		throw new LlamaSwapClientError(
			`llama-swap returned ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ""}${hint}`,
			response.status,
		);
	}

	let payload: OpenAIModelsListResponse;
	try {
		payload = (await response.json()) as OpenAIModelsListResponse;
	} catch {
		throw new LlamaSwapClientError("Invalid JSON from llama-swap /v1/models");
	}

	if (!Array.isArray(payload.data)) {
		throw new LlamaSwapClientError("Unexpected /v1/models response: missing data array");
	}

	return payload.data;
}
