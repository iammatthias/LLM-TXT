# LLM-TXT

Export social and web data as LLM-ready text files with x402 micropayments.

**Website:** [llm-txt.fun](https://llm-txt.fun)

## Platforms

| Platform | URL | Description |
|----------|-----|-------------|
| LLM-FID | [llm-fid.fun](https://llm-fid.fun) | Export Farcaster profiles and casts |
| LLM-BSKY | [llm-bsky.fun](https://llm-bsky.fun) | Export Bluesky profiles and posts |
| LLM-RSS | [llm-rss.fun](https://llm-rss.fun) | Export RSS/Atom feed content |
| LLM-GIT | [llm-git.fun](https://llm-git.fun) | Export Git repository metadata and files |

## API

All endpoints are available at `https://api.llm-txt.fun` and return plain text optimized for LLM consumption.

### Endpoints

#### GET /fid
Export Farcaster user profile and casts.

| Parameter | Type | Description |
|-----------|------|-------------|
| `fid` | number | Farcaster ID |
| `username` | string | Farcaster username (alternative to fid) |
| `limit` | number | Max casts to return (default: 50) |
| `all` | boolean | Fetch all casts |
| `includeReplies` | boolean | Include reply casts |
| `includeParents` | boolean | Include parent context for replies |
| `includeReactions` | boolean | Include reaction counts |
| `sortOrder` | string | "newest" or "oldest" |

#### GET /bsky
Export Bluesky user profile and posts.

| Parameter | Type | Description |
|-----------|------|-------------|
| `handle` | string | Bluesky handle (e.g., user.bsky.social) |
| `did` | string | Bluesky DID (alternative to handle) |
| `limit` | number | Max posts to return (default: 50) |
| `all` | boolean | Fetch all posts |
| `includeReplies` | boolean | Include reply posts |
| `includeParents` | boolean | Include parent context |
| `includeReactions` | boolean | Include reaction counts |
| `sortOrder` | string | "newest" or "oldest" |

#### GET /rss
Export RSS or Atom feed content.

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | Feed URL (required) |
| `limit` | number | Max items to return (default: 10) |
| `all` | boolean | Fetch all items |
| `includeContent` | boolean | Include full article content |
| `sortOrder` | string | "newest" or "oldest" |

#### GET /git
Export Git repository metadata, tree, and file contents.

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | Repository URL (required) |
| `branch` | string | Branch name (default: default branch) |
| `includeTree` | boolean | Include file tree listing |
| `includeContent` | boolean | Include file contents |
| `include` | string | Glob patterns to include (comma-separated) |
| `exclude` | string | Glob patterns to exclude (comma-separated) |
| `maxFileSize` | number | Max file size in bytes (default: 100000) |

#### GET /pricing
Get current pricing configuration for all endpoints.

## SDK

TypeScript SDK with built-in x402 payment handling.

```bash
npm install @llm-txt/sdk
```

### Quick Start

```typescript
import { LlmFidClient } from "@llm-txt/sdk";

// Initialize with optional wallet signer for payments
const client = new LlmFidClient({
  baseUrl: "https://api.llm-txt.fun",
  signer: walletClient  // viem WalletClient
});

// Get price estimate
const estimate = await client.getServerEstimate({
  username: "dwr.eth",
  limit: 100
});

// Fetch data (handles payment automatically)
const result = await client.fetch({
  username: "dwr.eth",
  limit: 100
});
```

### Available Clients

| Client | Description |
|--------|-------------|
| `LlmFidClient` | Farcaster data exports |
| `LlmBskyClient` | Bluesky data exports |
| `LlmRssClient` | RSS/Atom feed exports |
| `LlmGitClient` | Git repository exports |

## x402 Payments

Requests exceeding free tier limits require payment via [x402](https://x402.org). Payments are made in USDC on Base.

- Free tier available for small requests
- Pay-per-request micropayments
- Automatic payment handling with SDK
- Pricing scales with data volume

## Development

### Prerequisites

- [Bun](https://bun.sh) runtime
- Node.js 18+

### Setup

```bash
# Install dependencies
bun install

# Start development servers
bun run dev
```

### Project Structure

```
llm-txt/
├── server/          # Cloudflare Workers API server
├── sdk/             # TypeScript SDK (@llm-txt/sdk)
├── shared/          # Shared types and components
└── clients/
    ├── llm-fid/     # Farcaster client
    ├── llm-bsky/    # Bluesky client
    ├── llm-rss/     # RSS client
    ├── llm-git/     # Git client
    └── llm-txt/     # Homepage
```

### Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start all development servers |
| `bun run dev:server` | Start API server only |
| `bun run dev:fid` | Start Farcaster client |
| `bun run dev:bsky` | Start Bluesky client |
| `bun run dev:rss` | Start RSS client |
| `bun run dev:git` | Start Git client |
| `bun run dev:txt` | Start homepage |
| `bun run build` | Build all packages |
| `bun run deploy` | Deploy all services |
| `bun run test` | Run SDK tests |

## License

MIT
