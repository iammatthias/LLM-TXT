# LLM-FID

Web client for exporting Farcaster profiles and casts as LLM-ready text.

**Live:** [llm-fid.fun](https://llm-fid.fun)

## Features

- Export Farcaster user profiles and casts
- Search by username or FID
- Customize output with filters:
  - Number of casts to include
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

Uses the LLM-TXT API at `https://api.llm-txt.fun/fid`. See the [main README](../../README.md) for API documentation.
