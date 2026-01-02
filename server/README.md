# @llm-txt/server

API server for LLM-TXT, built on Cloudflare Workers with x402 payment integration.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /fid` | Export Farcaster profiles and casts |
| `GET /bsky` | Export Bluesky profiles and posts |
| `GET /rss` | Export RSS/Atom feed content |
| `GET /git` | Export Git repository metadata and files |
| `GET /pricing` | Get current pricing configuration |

## Development

```bash
# Start development server
bun run dev

# Deploy to Cloudflare
bun run deploy
```

## Environment Variables

Configure in `wrangler.json` or `.dev.vars`:

| Variable | Description |
|----------|-------------|
| `NEYNAR_API_KEY` | Neynar API key for Farcaster data |
| `FACILITATOR_URL` | x402 facilitator URL |
| `X402_BASE_PRICE` | Base price for API requests |
| `NETWORK` | Network for payments (base-mainnet) |
| `PAYMENT_RECIPIENT` | Wallet address for receiving payments |

## x402 Integration

This server uses [x402](https://x402.org) for micropayments. Requests exceeding free tier limits return a 402 Payment Required response with payment details in headers.
