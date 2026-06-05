/**
 * Pi extension entry: llama-swap provider with dynamic model discovery.
 *
 * Usage: pi -e /path/to/pi-llama-swap
 *
 * Config (optional): ~/.pi/agent/pi-llama-swap.json overrides defaults.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./lib/config.js";
import { refreshProvider } from "./lib/provider.js";

/**
 * Pi extension factory (async for model discovery before startup).
 * @param pi - Extension API instance.
 */
export default async function llamaSwapExtension(pi: ExtensionAPI): Promise<void> {
	const config = await loadConfig();
	const result = await refreshProvider(pi, config, { isInitial: true });

	if (result.error) {
		console.warn(`[llama-swap] ${result.error}`);
	}
}
