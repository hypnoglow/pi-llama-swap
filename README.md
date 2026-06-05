# pi-llama-swap

Pi coding agent extension that registers a **llama-swap** provider and discovers models from a running [llama-swap](https://github.com/mostlygeek/llama-swap) instance.

## What it does

- Injects provider `llama-swap` with models from `GET /v1/models`
- Resolves per-model context from llama-swap APIs (`/v1/models`, `/running`) with 256K default — see [Context window](#context-window-per-model)
- Uses OpenAI Chat Completions API (`openai-completions`) for streaming
- Reads optional config from `~/.pi/agent/pi-llama-swap.json` to override defaults

## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent (`@earendil-works/pi-coding-agent`)
- [llama-swap](https://github.com/mostlygeek/llama-swap) running and reachable
- Node.js 18+ (for `fetch`)

## Quick start

```bash
# Terminal 1: start llama-swap (example)
llama-swap --config ~/llama-swap/config.yaml --listen 127.0.0.1:8080

# Terminal 2: load extension
cd /path/to/pi-llama-swap
pi -e .
```

In pi: `/model` → pick `llama-swap/your-model-id`.

Verify from CLI:

```bash
pi -e . --list-models | grep llama-swap
curl http://127.0.0.1:8080/v1/models
```

## Configuration

### Defaults

| Setting | Default |
|---------|---------|
| Origin | `http://127.0.0.1` |
| Port | `8080` |
| Base URL | `http://127.0.0.1:8080/v1` |

No config file needed when llama-swap runs on the defaults above.

### Config file

Create `~/.pi/agent/pi-llama-swap.json` to override defaults:

```json
{
  "origin": "http://127.0.0.1",
  "port": 8080,
  "apiKey": "optional-key"
}
```

| Field | Description |
|-------|-------------|
| `origin` | Scheme + host (e.g. `http://192.168.1.10`) |
| `port` | TCP port (1–65535) |
| `basePath` | API path prefix (default `/v1`; normalized to end with `/v1`) |
| `apiKey` | Bearer token when llama-swap uses `apiKeys` |

Load order: **defaults → `~/.pi/agent/pi-llama-swap.json` → environment variables**.

### Context window (per model)

Context size applies **only** to `llama-swap/*` models registered by this extension. Other pi providers are unchanged.

Resolution runs once at extension startup (`pi -e .`) in `lib/context.ts` → `buildModelLimits()`:

1. **List models** — `GET {baseUrl}/models` (OpenAI-compatible `/v1/models`)
2. **Per model id**, set `contextWindow` using first match below
3. **Register** models with pi via `registerProvider("llama-swap", …)`

#### Resolution order (first match wins)

| Priority | Source | How |
|----------|--------|-----|
| 1 | `GET /v1/models` entry | Top-level: `context_length`, `max_context_length`, `context_window` |
| 2 | `GET /v1/models` metadata | `meta.llamaswap.context_length`, `.context`, `.max_context`, `.max_context_length`; or `meta.n_ctx`; or `metadata.context_length` / `metadata.context` |
| 3 | `GET /running` (loaded models only) | For each running process: upstream llama-server `GET {proxy}/props` → `default_generation_settings.n_ctx`; else parse `-c` / `--ctx-size` from `cmd` |
| 4 | Default | **256K** — `262144` tokens when nothing above reports a value |

`/running` overrides `/v1/models` for the same model id when both exist (running value wins).

#### Max output tokens (`maxTokens`)

| Source | Fallback |
|--------|----------|
| `output_length` or `max_tokens` on `/v1/models` (or `meta.llamaswap.*`) | `min(8192, floor(contextWindow / 4))` |

#### Typical behavior

- **Idle models** (not loaded in llama-swap yet): usually **256K** unless llama-swap adds context fields to `/v1/models`
- **Running model** at startup: real ctx from `/running` + upstream `/props` (e.g. `262144` from `-c` in cmd)
- **After load**: context does not auto-refresh — restart `pi -e .` to pick up new `/running` values

To expose ctx for all models without restart, configure llama-swap so `/v1/models` includes `context_length` (or `metadata.context_length`) per model.

#### Example

```bash
# See what pi registered
pi -e . --list-models | grep llama-swap

# Raw model list from llama-swap
curl -s http://127.0.0.1:8080/v1/models | jq '.data[] | {id, context_length, meta}'

# Running models + cmds (context for loaded upstream)
curl -s http://127.0.0.1:8080/running | jq
```

Restrict permissions when storing API keys:

```bash
chmod 600 ~/.pi/agent/pi-llama-swap.json
```

### Environment variables

Optional runtime overrides (highest precedence):

| Variable | Purpose |
|----------|---------|
| `LLAMA_SWAP_URL` | Origin URL (scheme + host, optional port/path) |
| `LLAMA_SWAP_PORT` | Port override |
| `LLAMA_SWAP_API_KEY` | API key override |

## Auth

If llama-swap uses `apiKeys` in its config, set `"apiKey"` in `pi-llama-swap.json` or `LLAMA_SWAP_API_KEY`.

Without a key, extension uses placeholder `local-no-auth` so models appear in `/model`. Pi may send `Authorization: Bearer local-no-auth`; most unsecured local installs ignore it.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `Cannot reach llama-swap` | Start llama-swap; check `origin`/`port` in config file |
| HTTP 401 | Set `apiKey` in config or `LLAMA_SWAP_API_KEY` |
| 0 models | Ensure models in llama-swap config; `curl http://127.0.0.1:8080/v1/models` |
| Extension loads but chat fails | Confirm model id; first request may load model (slow) |
| Config ignored | File must be `~/.pi/agent/pi-llama-swap.json`; restart pi after edits |

## Project layout

```
pi-llama-swap/
├── index.ts          # Extension entry
├── lib/
│   ├── config.ts     # Load ~/.pi/agent/pi-llama-swap.json
│   ├── url.ts        # URL building
│   ├── client.ts     # GET /v1/models
│   ├── context.ts    # Context window from llama-swap APIs
│   ├── provider.ts   # registerProvider
│   └── types.ts
├── package.json
└── README.md
```

## License

MIT (see repository if published).
