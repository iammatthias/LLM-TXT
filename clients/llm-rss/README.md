# LLM-RSS

Web client for exporting RSS/Atom feeds as LLM-ready text.

**Live:** [llm-rss.fun](https://llm-rss.fun)

## Features

- Export RSS and Atom feed content
- Parse any valid feed URL
- Customize output with filters:
  - Number of items to include
  - Sort order (newest/oldest)
  - Include full article content
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

Uses the LLM-TXT API at `https://api.llm-txt.fun/rss`. See the [main README](../../README.md) for API documentation.
