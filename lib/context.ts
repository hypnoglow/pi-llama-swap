/**
 * Resolve per-model context windows from llama-swap HTTP APIs only.
 */

import type { LlamaSwapConfig, OpenAIModelEntry } from "./types.js";
import { buildServerOrigin } from "./url.js";

/** Default context when llama-swap APIs do not report one (256K). */
export const DEFAULT_CONTEXT_WINDOW = 262_144;

const DEFAULT_MAX_TOKENS = 8192;

/** Running process entry from GET /running. */
interface RunningProcess {
	model: string;
	cmd?: string;
	proxy?: string;
	state?: string;
}

/** Response shape from GET /running. */
interface RunningResponse {
	running?: RunningProcess[];
}

/** llama-server /props response (subset). */
interface LlamaServerProps {
	default_generation_settings?: {
		n_ctx?: number;
	};
	capabilities?: unknown;
	modalities?: unknown;
	input?: unknown;
	vision?: unknown;
	supports_vision?: unknown;
	supports_images?: unknown;
}

/**
 * Coerces a value to a positive integer context size, or undefined if invalid.
 * @param value - Raw value from JSON.
 * @returns Valid context window or undefined.
 */
function toPositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && /^\d+$/.test(value)) {
		const n = Number(value);
		return n > 0 ? n : undefined;
	}
	return undefined;
}

/**
 * Returns whether a model property advertises image/vision input.
 * It checks a boolean `vision` and lists such as `capabilities: ["vision"]` or
 * `modalities: ["text", "image"]`.
 */
function supportsImageInput(props: LlamaServerProps): boolean {
	if (props.vision === true || props.supports_vision === true || props.supports_images === true) {
		return true;
	}

	const hasImageCapability = (value: unknown): boolean =>
		Array.isArray(value) &&
		value.some((item) => typeof item === "string" && /^(?:image|images|vision|multimodal)$/i.test(item));

	return hasImageCapability(props.capabilities) || hasImageCapability(props.modalities) || hasImageCapability(props.input);
}

/**
 * Extracts context length from a /v1/models entry (top-level or nested metadata).
 * @param entry - Model object from llama-swap.
 * @returns Context window in tokens, or undefined.
 */
export function extractContextFromModelEntry(entry: OpenAIModelEntry): number | undefined {
	const topLevel =
		toPositiveInt(entry.context_length) ??
		toPositiveInt(entry.max_context_length) ??
		toPositiveInt(entry.context_window);

	if (topLevel) {
		return topLevel;
	}

	const meta = entry.meta;
	if (meta && typeof meta === "object") {
		const llamaswap = (meta as Record<string, unknown>).llamaswap;
		if (llamaswap && typeof llamaswap === "object") {
			const ls = llamaswap as Record<string, unknown>;
			const fromLs =
				toPositiveInt(ls.context_length) ??
				toPositiveInt(ls.context) ??
				toPositiveInt(ls.max_context) ??
				toPositiveInt(ls.max_context_length);
			if (fromLs) {
				return fromLs;
			}
		}
		const fromMeta = toPositiveInt((meta as Record<string, unknown>).n_ctx);
		if (fromMeta) {
			return fromMeta;
		}
	}

	const metadata = entry.metadata;
	if (metadata && typeof metadata === "object") {
		const md = metadata as Record<string, unknown>;
		const fromMd = toPositiveInt(md.context_length) ?? toPositiveInt(md.context);
		if (fromMd) {
			return fromMd;
		}
	}

	return undefined;
}

/**
 * Extracts max output tokens from a /v1/models entry when present.
 * @param entry - Model object from llama-swap.
 * @returns Max output tokens or undefined.
 */
export function extractMaxTokensFromModelEntry(entry: OpenAIModelEntry): number | undefined {
	const top = toPositiveInt(entry.output_length) ?? toPositiveInt(entry.max_tokens);
	if (top) {
		return top;
	}

	const meta = entry.meta;
	if (meta && typeof meta === "object") {
		const llamaswap = (meta as Record<string, unknown>).llamaswap;
		if (llamaswap && typeof llamaswap === "object") {
			const fromLs =
				toPositiveInt((llamaswap as Record<string, unknown>).output_length) ??
				toPositiveInt((llamaswap as Record<string, unknown>).max_tokens);
			if (fromLs) {
				return fromLs;
			}
		}
	}

	return undefined;
}

/**
 * Parses `-c` or `--ctx-size` from a llama-server command string.
 * @param cmd - Shell command (may span multiple lines).
 * @returns Context size in tokens, or undefined.
 */
export function parseContextFromCmd(cmd: string): number | undefined {
	const ctxSizeMatch = cmd.match(/(?:^|\s)--ctx-size(?:=|\s+)(\d+)/);
	if (ctxSizeMatch) {
		return Number(ctxSizeMatch[1]);
	}

	const cMatch = cmd.match(/(?:^|\s)-c(?:=|\s+)(\d+)/);
	if (cMatch) {
		return Number(cMatch[1]);
	}

	return undefined;
}

/**
 * Fetches and parses a `/props` response.
 * @param url - Absolute `/props` URL.
 * @param headers - Optional request headers.
 * @returns Props or undefined when the endpoint is unavailable or invalid.
 */
async function fetchProps(url: URL | string, headers: Record<string, string> = { Accept: "application/json" }): Promise<LlamaServerProps | undefined> {
	try {
		const response = await fetch(url, { method: "GET", headers });
		if (!response.ok) {
			return undefined;
		}
		return (await response.json()) as LlamaServerProps;
	} catch {
		return undefined;
	}
}

/**
 * Fetches n_ctx from a running llama-server upstream `/props` endpoint.
 * @param proxyUrl - Upstream base URL (e.g. `http://localhost:5802`).
 * @returns Context window or undefined.
 */
async function fetchUpstreamContext(proxyUrl: string): Promise<number | undefined> {
	const props = await fetchProps(`${proxyUrl.replace(/\/$/, "")}/props`);
	return toPositiveInt(props?.default_generation_settings?.n_ctx);
}

/**
 * Fetches `/props` for every configured model.
 * A failed or unsupported request is omitted from the result.
 */
async function loadPropsForModels(
	serverOrigin: string,
	entries: OpenAIModelEntry[],
	apiKey?: string,
): Promise<Map<string, LlamaServerProps>> {
	const result = new Map<string, LlamaServerProps>();
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	await Promise.all(
		entries.map(async (entry) => {
			const url = new URL(`${serverOrigin.replace(/\/$/, "")}/props`);
			url.searchParams.set("model", entry.id);
			const props = await fetchProps(url, headers);
			if (props) {
				result.set(entry.id, props);
			}
		}),
	);

	return result;
}

/**
 * Fetches context hints from GET /running (upstream /props, else cmd parse).
 * @param serverOrigin - llama-swap root URL (no `/v1`).
 * @param apiKey - Optional Bearer token.
 * @returns Map of model id → context tokens.
 */
export async function loadContextFromRunning(
	serverOrigin: string,
	apiKey?: string,
): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	const url = `${serverOrigin.replace(/\/$/, "")}/running`;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	let response: Response;
	try {
		response = await fetch(url, { method: "GET", headers });
	} catch {
		return result;
	}

	if (!response.ok) {
		return result;
	}

	let payload: RunningResponse;
	try {
		payload = (await response.json()) as RunningResponse;
	} catch {
		return result;
	}

	const processes = payload.running ?? [];
	await Promise.all(
		processes.map(async (proc) => {
			if (!proc.model) {
				return;
			}

			let ctx: number | undefined;
			if (proc.proxy) {
				ctx = await fetchUpstreamContext(proc.proxy);
			}
			if (!ctx && proc.cmd) {
				ctx = parseContextFromCmd(proc.cmd);
			}
			if (ctx) {
				result.set(proc.model, ctx);
			}
		}),
	);

	return result;
}

/**
 * Builds per-model context and max-token maps from llama-swap APIs.
 * @param entries - Models from GET /v1/models.
 * @param config - Extension connection settings.
 * @returns Context and max-token maps keyed by model id.
 */
export async function buildModelLimits(
	entries: OpenAIModelEntry[],
	config: LlamaSwapConfig,
	overrides?: Record<string, number>,
): Promise<{
	contextByModel: Map<string, number>;
	maxTokensByModel: Map<string, number>;
	imageInputByModel: Map<string, boolean>;
}> {
	const contextByModel = new Map<string, number>();
	const maxTokensByModel = new Map<string, number>();

	for (const entry of entries) {
		const fromEntry = extractContextFromModelEntry(entry);
		if (fromEntry) {
			contextByModel.set(entry.id, fromEntry);
		}
		const maxOut = extractMaxTokensFromModelEntry(entry);
		if (maxOut) {
			maxTokensByModel.set(entry.id, maxOut);
		}
	}

	const serverOrigin = buildServerOrigin(config);
	const fromRunning = await loadContextFromRunning(serverOrigin, config.apiKey);
	for (const [id, ctx] of fromRunning) {
		contextByModel.set(id, ctx);
	}

	// ponyail: user overrides beat all discovered values
	if (overrides) {
		for (const [id, ctx] of Object.entries(overrides)) {
			contextByModel.set(id, ctx);
		}
	}
	const propsByModel = await loadPropsForModels(serverOrigin, entries, config.apiKey);
	const imageInputByModel = new Map(
		[...propsByModel].filter(([, props]) => supportsImageInput(props)).map(([id]) => [id, true] as const),
	);

	return { contextByModel, maxTokensByModel, imageInputByModel };
}

/**
 * Resolves context window for a model id from llama-swap APIs, else default 256K.
 * @param modelId - Model identifier.
 * @param contextByModel - Resolved context map.
 * @returns Context window in tokens.
 */
export function resolveContextWindow(modelId: string, contextByModel: Map<string, number>): number {
	return contextByModel.get(modelId) ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolves max output tokens for a model id.
 * @param modelId - Model identifier.
 * @param maxTokensByModel - Resolved max-token map.
 * @param contextWindow - Model context window.
 * @returns Max output tokens.
 */
export function resolveMaxTokens(
	modelId: string,
	maxTokensByModel: Map<string, number>,
	contextWindow: number,
): number {
	if (maxTokensByModel.has(modelId)) {
		return maxTokensByModel.get(modelId)!;
	}
	return Math.min(DEFAULT_MAX_TOKENS, Math.floor(contextWindow / 4));
}
