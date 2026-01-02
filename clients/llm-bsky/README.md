# LLM-BSKY

Web client for exporting Bluesky profiles and posts as LLM-ready text.

**Live:** [llm-bsky.fun](https://llm-bsky.fun)

## Features

- Export Bluesky user profiles and posts
- Search by handle or DID
- Customize output with filters:
  - Number of posts to include
  - Sort order (newest/oldest)
  - Include/exclude replies
  - Include reaction counts
  - Include parent context for replies
- x402 micropayments for large exports

## Development

```bash
# Start development server
bun run dev

# Build for production
bun run build

# Deploy
bun run deploy
```

## API

Uses the LLM-TXT API at `https://api.llm-txt.fun/bsky`. See the [main README](../../README.md) for API documentation.
