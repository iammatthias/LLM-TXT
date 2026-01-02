# @llm-txt/sdk

TypeScript SDK for the LLM-TXT API with built-in x402 payment handling.

## Installation

```bash
npm install @llm-txt/sdk
```

## Quick Start

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

## Available Clients

| Client | Description |
|--------|-------------|
| `LlmFidClient` | Farcaster data exports |
| `LlmBskyClient` | Bluesky data exports |
| `LlmRssClient` | RSS/Atom feed exports |
| `LlmGitClient` | Git repository exports |

## API Reference

### LlmFidClient

```typescript
interface FidParams {
  fid?: number;
  username?: string;
  limit?: number;
  all?: boolean;
  includeReplies?: boolean;
  includeParents?: boolean;
  includeReactions?: boolean;
  sortOrder?: "newest" | "oldest";
}
```

### LlmBskyClient

```typescript
interface BskyParams {
  handle?: string;
  did?: string;
  limit?: number;
  all?: boolean;
  includeReplies?: boolean;
  includeParents?: boolean;
  includeReactions?: boolean;
  sortOrder?: "newest" | "oldest";
}
```

### LlmRssClient

```typescript
interface RssParams {
  url: string;
  limit?: number;
  all?: boolean;
  includeContent?: boolean;
  sortOrder?: "newest" | "oldest";
}
```

### LlmGitClient

```typescript
interface GitParams {
  url: string;
  branch?: string;
  includeTree?: boolean;
  includeContent?: boolean;
  include?: string;
  exclude?: string;
  maxFileSize?: number;
}
```

## x402 Payments

The SDK automatically handles x402 micropayments when a wallet signer is provided. If a request requires payment:

1. The server returns a 402 Payment Required response
2. The SDK signs the payment with your wallet
3. The request is retried with the payment header
4. You receive your data

Without a signer, payment-required requests will throw an error with pricing details.

## License

MIT
