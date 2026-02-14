# OpenClaw Village

Welcome to OpenClaw Village, an autonomous agent application running on Cloudflare Workers (Durable Objects).

## ⚠️ Security Warning

**Before running or deploying, please read [OpenClaw Security Docs](https://docs.openclaw.ai/gateway/security).**

This application handles private keys (Hyperliquid) and AI API keys.
- **NEVER** commit `.dev.vars` or `.env` files.
- **NEVER** expose the `engine-api` worker to the public internet without authentication (Cloudflare Access or a shared secret).
- **Audit** your `task.md` and code for any hardcoded secrets.

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
    cp apps/engine-api/.dev.vars.example apps/engine-api/.dev.vars
    ```
    Edit `apps/engine-api/.dev.vars` and add your secrets.
    `OPENCLAW_GATEWAY_PASSWORD` is required because all `/api/*` and WS upgrade routes enforce shared-secret auth.
    > **Note**: `.dev.vars` is gitignored. Do not remove it from `.gitignore`.

3.  **Configure Secrets (Production)**:
    Use `wrangler secret put` to set secrets for the deployed worker:
    ```bash
    cd apps/engine-api
    bunx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY
    bunx wrangler secret put HL_PRIVATE_KEY
    # ... repeat for all required vars
    ```

## Local Development

To run the `engine-api` locally:

```bash
# From root
bun run dev --filter engine-api

# Or directly in apps/engine-api
cd apps/engine-api
bun run dev
```

This starts the worker on `http://localhost:8787`.
- **Note**: Durable Objects persist data locally in `.wrangler/state/v3`. To reset, delete this folder or run `wrangler dev --persist-to=memory`.

## Deployment

### 1. Prerequisites (Cloudflare)

*   **Paid Workers Plan**: Required for Durable Objects.
*   **R2 Enabled**: You must have R2 enabled on your account.
*   **AI Gateway**: Ensure you have an AI Gateway created (id: `openclaw-core`).

### 2. Infrastructure Setup (One-time)

Create the R2 bucket and set production secrets:

```bash
# Create R2 Bucket
bunx wrangler r2 bucket create openclaw-village-data

# Set backend secrets (you'll be prompted for each value)
cd apps/engine-api
bunx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY
bunx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID
bunx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID
bunx wrangler secret put HL_PRIVATE_KEY
bunx wrangler secret put HL_WALLET_ADDRESS
bunx wrangler secret put OPENCLAW_GATEWAY_PASSWORD
# Optional fallback
bunx wrangler secret put ENABLE_CCXT_FALLBACK
bunx wrangler secret put CCXT_BINANCE_API_KEY
bunx wrangler secret put CCXT_BINANCE_API_SECRET
```

### 3. Deploy Everything

Deploy from root (builds first, then deploys all apps):

```bash
bun run deploy
```

Or deploy each app individually:

```bash
# Backend (Cloudflare Workers + Durable Objects)
cd apps/engine-api
bun run deploy

# Frontend (Cloudflare Pages)
cd apps/agent-dashboard
bun run deploy
```

> **First Deploy**: The first `engine-api` deployment creates the Durable Object classes and R2 bindings automatically.

### 4. Post-Deployment Configuration

1.  **CORS**: Update `apps/engine-api/src/index.ts` with your Pages URL:
    ```ts
    origin: ["http://localhost:5173", "https://openclaw-agent-dashboard.pages.dev"],
    ```
2.  **Frontend API URL**: Set via Cloudflare Pages environment variable or `.env.production`:
    ```
    VITE_API_URL=https://engine-api.<your-subdomain>.workers.dev
    VITE_GATEWAY_PASSWORD=<same-shared-password>
    VITE_ROOM_ID=main
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

## Architecture & Security

### Core Components
- **`apps/engine-api`**: The Core Worker.
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
- **Secrets**: Managed via `wrangler secret`. No keys in code.
- **Environment**: Explicit `HYPERLIQUID_TESTNET` flag to prevent accidental mainnet trading.
