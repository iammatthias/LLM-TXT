# shared

Shared types, components, and utilities for the LLM-TXT project.

## Contents

### Types

Shared TypeScript types for API requests and responses:

- `FarcasterMessage` - Farcaster cast structure
- `BlueskyPost` - Bluesky post structure
- `RssFeedItem` - RSS feed item structure
- `GitRepositoryInfo` - Git repository metadata

### Components (React)

Shared UI components using the terminal design system:

- `Terminal` - Main container component
- `TerminalHeader` - Page header with title/subtitle
- `TerminalSection` - Content section with header
- `TerminalFooter` - Page footer with links
- `GenerativePattern` - Decorative SVG pattern
- `PricingTable` - Dynamic pricing display

### Hooks

- `usePricing` - Fetch and cache API pricing data

### Styles

- `terminal.css` - Complete design system with CSS custom properties

## Development

```bash
# Build the package
bun run build

# Watch for changes
bun run dev
```

## Usage

This package is used internally by the LLM-TXT clients and is not published to npm.

```typescript
// Import types
import type { FarcasterMessage } from "shared";

// Import components
import { Terminal, TerminalSection } from "../../shared";

// Import styles
@import "../../shared/styles/terminal.css";
```
