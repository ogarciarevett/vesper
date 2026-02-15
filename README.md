# OpenClaw Village

Welcome to OpenClaw Village, an autonomous agent application running on Cloudflare Workers (Durable Objects).

## ⚠️ Security Warning

**Before running or deploying, please read [OpenClaw Security Docs](https://docs.openclaw.ai/gateway/security).**

This application handles private keys (Hyperliquid) and gateway auth credentials.
- **NEVER** commit `.dev.vars` or `.env` files.
- **NEVER** expose the `agent-api` worker to the public internet without authentication (Cloudflare Access or a shared secret).
- **Audit** your `task.md` and code for any hardcoded secrets.

## Server-Only Config (Bindings / Secrets)

These values must stay server-side only (Workers/Pages Functions runtime):

- `OPENCLAW_GATEWAY_PASSWORD`
- `HL_PRIVATE_KEY`
- `CF_AI_GATEWAY_ACCOUNT_ID`
- `CF_AI_GATEWAY_ID`
- `CF_AIG_AUTH_TOKEN` (if AI Gateway Authenticated Gateway is enabled)
- `CCXT_BINANCE_API_KEY`
- `CCXT_BINANCE_API_SECRET`

Do not expose any of the values above via `VITE_*` env vars in frontend code.

## Prerequisites

- [Bun](https://bun.sh) (v1.2+)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (v3.50+)
- Cloudflare Account (Workers Paid plan required for Durable Objects)

## Setup

1.  **Install Dependencies**:
    ```bash
    bun install
    ```

2.  **Configure Secrets (Local Development)**:
    Copy the example vars file for the worker:
    ```bash
    cp apps/agent-api/.dev.vars.example apps/agent-api/.dev.vars
    ```
    Edit `apps/agent-api/.dev.vars` and add your secrets.
    `OPENCLAW_GATEWAY_PASSWORD` is required because all `/api/*` and WS upgrade routes enforce shared-secret auth.
    > **Note**: `.dev.vars` is gitignored. Do not remove it from `.gitignore`.

3.  **Configure Dashboard BFF (Local Development)**:
    Create `apps/agent-dashboard/.env.local`:
    ```bash
    AGENT_API_URL=http://localhost:8787
    OPENCLAW_GATEWAY_PASSWORD=<same value as agent-api>
    VITE_ROOM_ID=main
    ```
    Keep `VITE_API_URL` unset to use same-origin `/api` proxy.

    If you run Pages Functions locally with Wrangler, also copy:
    ```bash
    cp apps/agent-dashboard/.dev.vars.example apps/agent-dashboard/.dev.vars
    ```

4.  **Configure Secrets (Production)**:
    Use `wrangler secret put` to set secrets for the deployed worker:
    ```bash
    cd apps/agent-api
    bunx wrangler secret put CF_AIG_AUTH_TOKEN
    bunx wrangler secret put HL_PRIVATE_KEY
    # ... repeat for all required vars
    ```

## Local Development

To run the `agent-api` locally:

```bash
# From root
bun run dev --filter agent-api

# Or directly in apps/agent-api
cd apps/agent-api
bun run dev
```

This starts the worker on `http://localhost:8787`.
- **Note**: Durable Objects persist data locally in `.wrangler/state/v3`. To reset, delete this folder or run `wrangler dev --persist-to=memory`.

## Deployment

### 1. Prerequisites (Cloudflare)

*   **Paid Workers Plan**: Required for Durable Objects.
*   **R2 Enabled**: You must have R2 enabled on your account.
*   **AI Gateway**: Ensure you have an AI Gateway created (id: `openclaw-core`).
    Configure provider keys in AI Gateway BYOK (not in Worker env vars).

### 2. Infrastructure Setup (One-time)

Create the R2 bucket and set production secrets:

```bash
# Create R2 Bucket
bunx wrangler r2 bucket create openclaw-village-data

# Set backend secrets (you'll be prompted for each value)
cd apps/agent-api
bunx wrangler secret put CF_AIG_AUTH_TOKEN
bunx wrangler secret put HL_PRIVATE_KEY
bunx wrangler secret put HL_WALLET_ADDRESS
bunx wrangler secret put OPENCLAW_GATEWAY_PASSWORD
# Optional fallback
bunx wrangler secret put ENABLE_CCXT_FALLBACK
bunx wrangler secret put CCXT_BINANCE_API_KEY
bunx wrangler secret put CCXT_BINANCE_API_SECRET
```

`CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_ID` are configured as worker vars in `apps/agent-api/wrangler.toml` by default.

### 3. Deploy Everything

Deploy from root (builds first, then deploys all apps):

```bash
bun run deploy
```

Or deploy each app individually:

```bash
# Backend (Cloudflare Workers + Durable Objects)
cd apps/agent-api
bun run deploy

# Frontend (Cloudflare Pages)
cd apps/agent-dashboard
bun run deploy
```

> **First Deploy**: The first `agent-api` deployment creates the Durable Object classes and R2 bindings automatically.

### 4. Post-Deployment Configuration

1.  **CORS**: Update `apps/agent-api/src/index.ts` with your Pages URL:
    ```ts
    origin: ["http://localhost:5173", "https://openclaw-agent-dashboard.pages.dev"],
    ```
2.  **Frontend API URL / Room**: Set via Cloudflare Pages environment variable or `.env.production`:
    ```
    VITE_ROOM_ID=main
    ```
    Leave `VITE_API_URL` empty to call same-origin `/api` (recommended with BFF).

3.  **Dashboard BFF Variables (Pages Functions)**:
    Configure for `openclaw-agent-dashboard`:
    - `AGENT_API_URL=https://agent-api.<your-subdomain>.workers.dev` (Pages var)
    - `OPENCLAW_GATEWAY_PASSWORD` (Pages secret)

    Example:
    ```bash
    cd apps/agent-dashboard
    bunx wrangler pages secret put OPENCLAW_GATEWAY_PASSWORD --project-name=openclaw-agent-dashboard
    ```

### 5. CI/CD (Automatic Deploys)

A GitHub Actions workflow (`.github/workflows/deploy.yml`) is configured to automatically build and deploy on every push to `main`.

**Required GitHub Secrets:**

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | API Token with Workers/Pages deploy permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID |

To create the API token:
1. Go to [Cloudflare Dashboard → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create a token with **Edit Cloudflare Workers** permissions
3. Add the token as `CLOUDFLARE_API_TOKEN` in your GitHub repo Settings → Secrets

## Testing

Run the test suite:

```bash
bun run test
```

Integration tests for WS + emergency-stop are opt-in and run when:

- `OPENCLAW_INTEGRATION_BASE_URL` is set (example: `http://localhost:8787`)
- `OPENCLAW_GATEWAY_PASSWORD` is set

## AI Gateway BYOK (Multi-Model)

- The worker now uses AI Gateway `compat/chat/completions` and does **not** send provider `x-api-key` headers.
- Default model can be set with `CF_AI_DEFAULT_MODEL` (example: `anthropic/claude-opus-4-6`).
- You can expose a curated model list for the room UI with `CF_AI_MODEL_CATALOG` (JSON array).
- If `CF_AI_MODEL_CATALOG` is not set, the API tries to discover models from AI Gateway (`/compat/models` then `/models`) and probes each model status.
- Per bot, you can override model and BYOK alias with `reasoning` config:

```json
{
  "config": {
    "reasoning": {
      "model": "openai/gpt-4.1-mini",
      "byokAlias": "bot-alpha-openai",
      "temperature": 0.2,
      "maxTokens": 800,
      "intervalSeconds": 5
    }
  }
}
```

This allows different bots to use different providers/keys through a single gateway.

## Architecture & Security

### Core Components
- **`apps/agent-api`**: The Core Worker.
    - `TradingRoom`: Manages WebSocket sessions and bot coordination.
    - `BotInstance`: Autonomous agent loop with AI-driven trading decisions.
    - `StorageAdapter`: Handles persistence with `ctx.waitUntil` for reliability.
- **`packages/hyperliquid-sdk`**: Type-safe SDK for trading.

### Persistence Strategy
- **Layer 1**: Durable Object Storage (Fast, atomic, consistent).
- **Layer 2**: R2 Bucket (Async backup, durable, queryable).
- **Reliability**: All background writes use `ctx.waitUntil` to prevent data loss on DO eviction.

### Security
- **AI Gateway**: All LLM calls are routed through Cloudflare AI Gateway for observability and rate limiting.
- **BYOK**: Provider API keys are stored in Cloudflare AI Gateway BYOK, not in this repo/worker env.
- **Secrets**: Managed via `wrangler secret`. No keys in code.
- **Environment**: Explicit `HYPERLIQUID_TESTNET` flag to prevent accidental mainnet trading.
- **Frontend BFF**: Dashboard uses server-side `/api` proxy (Pages Functions) so gateway secrets are not exposed to browser bundles.

## Auth Roadmap

Current setup uses a shared secret between dashboard BFF and `agent-api`. End-user auth is planned via **Clerk** in a future iteration once trading flows are stable in Cloudflare.
