# LLM-GIT

Web client for exporting Git repositories as LLM-ready text.

**Live:** [llm-git.fun](https://llm-git.fun)

## Features

- Export Git repository metadata and file contents
- Support for GitHub repositories
- Customize output with filters:
  - Branch selection
  - Include/exclude file tree
  - Include/exclude file contents
  - Glob patterns for file inclusion/exclusion
  - Max file size limits
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

Uses the LLM-TXT API at `https://api.llm-txt.fun/git`. See the [main README](../../README.md) for API documentation.
