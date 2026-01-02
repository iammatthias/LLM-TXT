import { Hono } from "hono";
import { cors } from "hono/cors";
import type { FarcasterResponse, FarcasterUser, FarcasterCast, FarcasterQueryParams } from "shared";
import type { BlueskyResponse, BlueskyUser, BlueskyPost, BlueskyQueryParams } from "shared";
import type { RssResponse, RssFeed, RssItem, RssQueryParams } from "shared";
import type { GitResponse, GitRepo, GitFile, GitQueryParams, GitResponseMeta } from "shared";
import picomatch from "picomatch";
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { AtpAgent } from "@atproto/api";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";
import type { Network } from "@x402/core/types";
import { generateJwt } from "@coinbase/cdp-sdk/auth";

type Bindings = {
  NEYNAR_API_KEY: string;
  SNAPCHAIN_BASE_URL: string;
  CORS_ORIGIN: string;
  X402_PAY_TO: string; // Wallet address to receive payments
  X402_BASE_PRICE: string; // Base price per request (e.g., "$0.001")
  X402_NETWORK: string; // Network (e.g., "eip155:8453" for Base mainnet)
  X402_FACILITATOR_URL: string; // Facilitator URL
  BSKY_SERVICE_URL: string; // Bluesky API service URL
  // CDP API credentials for mainnet facilitator
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
};

// Dynamic pricing based on query parameters
// Reflects actual API cost - more data = more Neynar API calls = higher price
interface PricingParams {
  limit?: number;
  all?: boolean;
  includeReplies?: boolean;
  includeParents?: boolean;
  includeReactions?: boolean;
}

// Free tier configuration
const FREE_TIER = {
  maxLimit: 10, // Up to 10 casts free
  allowReplies: false,
  allowParents: false,
  allowAll: false,
};

// Pricing configuration - reflects actual Neynar API costs
// Based on Neynar's API structure and rate limits
const PRICING = {
  // Cost per API call (covers Neynar costs + margin)
  perApiCall: 0.001,

  // Neynar pagination
  castsPerPage: 150,

  // Fetch all: default estimate when cast count unknown
  // Client should provide actual cast count for accurate pricing
  fetchAllDefaultPages: 50,

  // Small buffer for pagination edge cases
  fetchAllBuffer: 5,

  // Parent lookup ratios (each parent = 1 API call)
  // These are based on typical Farcaster usage patterns
  parentRatioWithReplies: 0.6, // 60% of casts are replies when includeReplies=true
  parentRatioWithoutReplies: 0.1, // 10% edge case (shouldn't happen often)

  // Data complexity multipliers (for processing/bandwidth costs)
  repliesDataMultiplier: 1.25, // 25% more data with replies
  reactionsDataMultiplier: 1.1, // 10% more data with reactions
};

/**
 * Check if request qualifies for free tier
 */
function isFreeTier(params: PricingParams): boolean {
  const limit = params.limit || 50;

  // Free tier: up to 10 casts with no extra features
  if (limit > FREE_TIER.maxLimit) return false;
  if (params.all) return false;
  if (params.includeReplies) return false;
  if (params.includeParents) return false;

  return true;
}

/**
 * Calculate price based on estimated API calls and data complexity
 *
 * Cost drivers:
 * 1. Cast fetching: ceil(limit / 150) API calls
 * 2. Parent lookups: N API calls (1 per unique parent)
 * 3. Data multipliers: replies/reactions increase response size
 */
function calculateDynamicPrice(params: PricingParams, basePrice: number): string {
  // Free tier returns $0
  if (isFreeTier(params)) {
    return "$0";
  }

  const { perApiCall, castsPerPage, fetchAllDefaultPages, fetchAllBuffer } = PRICING;

  // Start with base API calls for fetching casts
  const requestedLimit = params.all ? (fetchAllDefaultPages * castsPerPage) : (params.limit || 50);
  const castPages = Math.ceil(requestedLimit / castsPerPage);

  let apiCalls = castPages;

  // Fetch all: add buffer for pagination edge cases
  if (params.all) {
    apiCalls += fetchAllBuffer;
  }

  // Parent lookups are the expensive part
  // Each unique parent hash requires a separate API call
  if (params.includeParents) {
    const parentRatio = params.includeReplies
      ? PRICING.parentRatioWithReplies
      : PRICING.parentRatioWithoutReplies;

    const estimatedParentCalls = Math.ceil(requestedLimit * parentRatio);
    apiCalls += estimatedParentCalls;
  }

  // Calculate base cost from API calls
  let cost = apiCalls * perApiCall;

  // Apply data complexity multipliers (stacking)
  if (params.includeReplies) {
    cost *= PRICING.repliesDataMultiplier;
  }
  if (params.includeReactions) {
    cost *= PRICING.reactionsDataMultiplier;
  }

  // Ensure minimum price
  cost = Math.max(cost, basePrice);

  // Round to 6 decimal places
  const rounded = Math.round(cost * 1000000) / 1000000;
  return `$${rounded}`;
}

function parseDollarPrice(price: string): number {
  return parseFloat(price.replace("$", ""));
}

/**
 * Calculate price with actual cast count for "all" queries
 */
function calculateDynamicPriceWithCastCount(
  params: PricingParams,
  castCount: number | null,
  basePrice: number
): string {
  if (isFreeTier(params)) {
    return "$0";
  }

  const { perApiCall, castsPerPage, fetchAllDefaultPages, fetchAllBuffer } = PRICING;

  // Calculate actual casts to fetch
  let requestedLimit: number;
  if (params.all) {
    // Use actual cast count if available, otherwise use default estimate
    requestedLimit = castCount !== null ? castCount : (fetchAllDefaultPages * castsPerPage);
  } else {
    requestedLimit = params.limit || 50;
  }

  const castPages = Math.ceil(requestedLimit / castsPerPage);
  let apiCalls = castPages;

  // Add buffer for "all" queries
  if (params.all) {
    apiCalls += fetchAllBuffer;
  }

  // Parent lookups
  if (params.includeParents) {
    const parentRatio = params.includeReplies
      ? PRICING.parentRatioWithReplies
      : PRICING.parentRatioWithoutReplies;
    const estimatedParentCalls = Math.ceil(requestedLimit * parentRatio);
    apiCalls += estimatedParentCalls;
  }

  // Calculate base cost
  let cost = apiCalls * perApiCall;

  // Apply data multipliers
  if (params.includeReplies) {
    cost *= PRICING.repliesDataMultiplier;
  }
  if (params.includeReactions) {
    cost *= PRICING.reactionsDataMultiplier;
  }

  // Ensure minimum
  cost = Math.max(cost, basePrice);

  // Round to 6 decimal places
  const rounded = Math.round(cost * 1000000) / 1000000;
  return `$${rounded}`;
}

// Cache for Neynar clients per API key
const clientCache = new Map<string, NeynarAPIClient>();

function getClient(apiKey: string): NeynarAPIClient {
  if (!apiKey) {
    throw new Error("NEYNAR_API_KEY environment variable is required");
  }

  if (!clientCache.has(apiKey)) {
    clientCache.set(apiKey, new NeynarAPIClient(
      new Configuration({ apiKey })
    ));
  }

  return clientCache.get(apiKey)!;
}

// Simple cache - SDK handles its own caching
const cache = new Map<string, { data: any; expiry: number }>();

function getCached<T>(key: string): T | null {
  const item = cache.get(key);
  if (!item || Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setCache<T>(key: string, data: T, ttl = 60000) {
  cache.set(key, { data, expiry: Date.now() + ttl });
}

// Rate limiter for Starter plan (300 RPM per endpoint, 500 RPM global)
class RateLimiter {
  private endpointRequests = new Map<string, number[]>();
  private globalRequests: number[] = [];
  private readonly ENDPOINT_LIMIT = 250; // Safety margin below 300 RPM
  private readonly GLOBAL_LIMIT = 450; // Safety margin below 500 RPM
  private readonly WINDOW_MS = 60000; // 1 minute

  private cleanOldRequests(requests: number[]): number[] {
    const now = Date.now();
    return requests.filter((timestamp) => now - timestamp < this.WINDOW_MS);
  }

  async waitForSlot(endpoint: string): Promise<void> {
    const now = Date.now();

    // Clean old requests
    this.globalRequests = this.cleanOldRequests(this.globalRequests);
    const endpointReqs = this.cleanOldRequests(this.endpointRequests.get(endpoint) || []);
    this.endpointRequests.set(endpoint, endpointReqs);

    // Check if we're at limits
    const globalCount = this.globalRequests.length;
    const endpointCount = endpointReqs.length;

    if (globalCount >= this.GLOBAL_LIMIT || endpointCount >= this.ENDPOINT_LIMIT) {
      // Calculate wait time until oldest request expires
      const relevantRequests =
        globalCount >= this.GLOBAL_LIMIT
          ? this.globalRequests
          : endpointReqs;

      const oldestRequest = relevantRequests[0];
      if (!oldestRequest) {
        // Shouldn't happen, but safety check
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return this.waitForSlot(endpoint);
      }

      const waitTime = this.WINDOW_MS - (now - oldestRequest) + 100; // +100ms buffer

      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.waitForSlot(endpoint); // Retry after waiting
    }

    // Record this request
    this.globalRequests.push(now);
    endpointReqs.push(now);
    this.endpointRequests.set(endpoint, endpointReqs);
  }
}

const rateLimiter = new RateLimiter();

// Resolve username to FID
async function resolveFid(username: string, apiKey: string): Promise<number> {
  const normalized = username.toLowerCase().replace(/^@/, "");
  const cached = getCached<number>(`fid:${normalized}`);
  if (cached) return cached;

  const { user } = await getClient(apiKey).lookupUserByUsername({ username: normalized });
  if (!user?.fid) throw new Error(`User not found: ${username}`);

  setCache(`fid:${normalized}`, user.fid, 300000); // 5 min
  return user.fid;
}

// Transform SDK responses
function transformUser(u: any): FarcasterUser {
  return {
    fid: u.fid,
    username: u.username,
    displayName: u.display_name || "",
    bio: u.profile?.bio?.text || "",
    pfp: u.pfp_url || "",
    url: "",
    location: "",
    twitter: "",
    github: "",
  };
}

function transformCast(c: any): FarcasterCast {
  return {
    hash: c.hash,
    threadHash: c.thread_hash,
    parentHash: c.parent_hash || undefined,
    author: { fid: c.author.fid, username: c.author.username || "" },
    text: c.text,
    timestamp: c.timestamp,
    attachments: [],
    embeds: c.embeds?.map((e: any) => ({ type: "url", url: e.url })) || [],
    reactions: {
      likes: c.reactions?.likes_count || 0,
      recasts: c.reactions?.recasts_count || 0,
    },
  };
}

// Main fetch function
async function fetchUserData(
  fidOrUsername: number | string,
  params: FarcasterQueryParams,
  apiKey: string
): Promise<FarcasterResponse & { params?: FarcasterQueryParams }> {
  const fid = typeof fidOrUsername === "number" ? fidOrUsername : await resolveFid(fidOrUsername, apiKey);

  // Get user
  const { users } = await getClient(apiKey).fetchBulkUsers({ fids: [fid] });
  if (!users?.[0]) throw new Error(`User not found: ${fid}`);
  const user = transformUser(users[0]);

  // Get casts
  const casts = await fetchCasts(fid, params, apiKey);

  return { user, casts, params };
}

async function fetchCasts(fid: number, params: FarcasterQueryParams, apiKey: string): Promise<FarcasterCast[]> {
  const fetchAll = params.all === true;
  const limit = fetchAll ? Infinity : (Number(params.limit) || 50);
  const includeReplies = params.includeReplies === true;
  const includeParents = params.includeParents === true;
  const sortOrder = params.sortOrder || "newest";

  const allCasts: FarcasterCast[] = [];
  let cursor: string | undefined;

  // Paginate through casts with rate limiting
  do {
    await rateLimiter.waitForSlot("/v2/farcaster/feed/user/casts");

    const res = await getClient(apiKey).fetchCastsForUser({
      fid,
      limit: 150, // Always fetch max per request for efficiency
      cursor,
      includeReplies: includeReplies || undefined,
    });

    const filtered = (res.casts || [])
      .filter((c: any) => includeReplies || !c.parent_hash)
      .map(transformCast);

    allCasts.push(...filtered);
    cursor = res.next?.cursor || undefined;

    // Continue if fetching all, or until we reach the limit
  } while (cursor && (fetchAll || allCasts.length < limit));

  // Apply sort order if specified
  if (sortOrder === "oldest") {
    allCasts.reverse();
  }

  // Fetch parents if needed (with rate limiting)
  if (includeParents) {
    const parentHashes = [...new Set(allCasts.map((c) => c.parentHash).filter(Boolean))];
    const parentMap: Record<string, FarcasterCast> = {};

    // Process in larger batches with rate limiter (increased from 5 to 25)
    const batchSize = 25;
    for (let i = 0; i < parentHashes.length; i += batchSize) {
      const batch = parentHashes.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (hash) => {
          try {
            await rateLimiter.waitForSlot("/v2/farcaster/cast");
            const res = await getClient(apiKey).lookupCastByHashOrUrl({
              identifier: hash!,
              type: "hash",
            });
            return [hash, res.cast ? transformCast(res.cast) : null] as const;
          } catch (err) {
            console.error(`Failed to fetch parent cast ${hash}:`, err);
            return [hash, null] as const;
          }
        })
      );

      results.forEach(([hash, cast]) => {
        if (cast) parentMap[hash as string] = cast;
      });
    }

    allCasts.forEach((c) => {
      if (c.parentHash && parentMap[c.parentHash]) {
        c.parentCast = parentMap[c.parentHash];
      }
    });
  }

  // Return all casts if fetchAll is true, otherwise respect the limit
  return fetchAll ? allCasts : allCasts.slice(0, limit);
}

// Format output
function formatTextOutput(data: FarcasterResponse & { params?: FarcasterQueryParams }): string {
  const { user, casts, params } = data;
  const includeReactions = params?.includeReactions === true;

  let out = `Farcaster User Profile\n===================\n\n`;
  out += `Username: ${user.username}\n`;
  out += `Display Name: ${user.displayName || "N/A"}\n`;
  out += `FID: ${user.fid}\n`;
  if (user.bio) out += `Bio: ${user.bio}\n`;
  if (user.pfp) out += `Profile Picture: ${user.pfp}\n`;
  out += `\nPosts\n=====\n\n`;

  if (!casts.length) {
    out += "No posts found.\n";
  } else {
    casts.forEach((cast, i) => {
      out += `[${i + 1}] ${cast.timestamp}\n`;
      if (cast.parentHash) out += `\n[Reply]\n`;
      out += `${cast.text}\n`;

      // Only show reactions if includeReactions is true
      if (includeReactions) {
        out += `\nReactions:\n`;
        out += `- Likes: ${cast.reactions.likes}\n`;
        out += `- Recasts: ${cast.reactions.recasts}\n`;
      }

      const embeds = cast.embeds?.filter((e) => e?.url) || [];
      if (embeds.length) {
        out += `\nEmbeds:\n${embeds.map((e) => `- ${e.url}`).join("\n")}\n`;
      }
      out += `\n---\n\n`;
    });
  }

  return out;
}

// ============================================================
// BLUESKY SUPPORT
// ============================================================

// Cache for Bluesky ATP agents
const bskyClientCache = new Map<string, AtpAgent>();

function getBskyClient(serviceUrl: string): AtpAgent {
  if (!bskyClientCache.has(serviceUrl)) {
    bskyClientCache.set(serviceUrl, new AtpAgent({ service: serviceUrl }));
  }
  return bskyClientCache.get(serviceUrl)!;
}

// Resolve Bluesky handle to DID
async function resolveBskyHandle(handle: string, serviceUrl: string): Promise<string> {
  const normalized = handle.toLowerCase().replace(/^@/, "");
  const cached = getCached<string>(`bsky:did:${normalized}`);
  if (cached) return cached;

  const agent = getBskyClient(serviceUrl);
  const response = await agent.getProfile({ actor: normalized });
  if (!response.data?.did) throw new Error(`User not found: ${handle}`);

  setCache(`bsky:did:${normalized}`, response.data.did, 300000); // 5 min
  return response.data.did;
}

// Transform Bluesky profile to our interface
function transformBskyUser(profile: any): BlueskyUser {
  return {
    did: profile.did,
    handle: profile.handle,
    displayName: profile.displayName || "",
    description: profile.description || "",
    avatar: profile.avatar || "",
    banner: profile.banner || "",
    followersCount: profile.followersCount,
    followsCount: profile.followsCount,
    postsCount: profile.postsCount,
  };
}

// Transform Bluesky post embed
function transformBskyEmbed(embed: any): Array<{ type: "image" | "external" | "record" | "video"; url?: string; title?: string; description?: string }> {
  if (!embed) return [];

  const embeds: Array<{ type: "image" | "external" | "record" | "video"; url?: string; title?: string; description?: string }> = [];

  // Handle images
  if (embed.$type === "app.bsky.embed.images#view" && embed.images) {
    embed.images.forEach((img: any) => {
      embeds.push({ type: "image", url: img.fullsize || img.thumb });
    });
  }

  // Handle external links
  if (embed.$type === "app.bsky.embed.external#view" && embed.external) {
    embeds.push({
      type: "external",
      url: embed.external.uri,
      title: embed.external.title,
      description: embed.external.description,
    });
  }

  // Handle record embeds (quote posts)
  if (embed.$type === "app.bsky.embed.record#view" && embed.record) {
    embeds.push({ type: "record", url: embed.record.uri });
  }

  // Handle video
  if (embed.$type === "app.bsky.embed.video#view") {
    embeds.push({ type: "video", url: embed.playlist || embed.thumbnail });
  }

  return embeds;
}

// Transform Bluesky feed item to our post interface
function transformBskyPost(item: any): BlueskyPost {
  const post = item.post;
  const record = post.record;

  return {
    uri: post.uri,
    cid: post.cid,
    author: {
      did: post.author.did,
      handle: post.author.handle,
    },
    text: record.text || "",
    createdAt: record.createdAt,
    replyParent: record.reply?.parent?.uri,
    replyRoot: record.reply?.root?.uri,
    embeds: transformBskyEmbed(post.embed),
    likeCount: post.likeCount || 0,
    repostCount: post.repostCount || 0,
    replyCount: post.replyCount || 0,
    quoteCount: post.quoteCount || 0,
  };
}

// Fetch Bluesky posts with pagination
async function fetchBskyPosts(
  actor: string,
  params: BlueskyQueryParams,
  serviceUrl: string
): Promise<BlueskyPost[]> {
  const agent = getBskyClient(serviceUrl);
  const fetchAll = params.all === true;
  const limit = fetchAll ? Infinity : (Number(params.limit) || 50);
  const includeReplies = params.includeReplies === true;
  const includeParents = params.includeParents === true;
  const sortOrder = params.sortOrder || "newest";

  // Bluesky filter options
  const filter = includeReplies ? "posts_with_replies" : "posts_no_replies";

  const allPosts: BlueskyPost[] = [];
  let cursor: string | undefined;

  do {
    await rateLimiter.waitForSlot("bsky:getAuthorFeed");

    const res = await agent.getAuthorFeed({
      actor,
      limit: 100, // Bluesky max per request
      cursor,
      filter,
    });

    // Filter out reposts (they have a reason field)
    const transformed = res.data.feed
      .filter((item: any) => !item.reason)
      .map(transformBskyPost);

    allPosts.push(...transformed);
    cursor = res.data.cursor;

  } while (cursor && (fetchAll || allPosts.length < limit));

  // Sort if needed
  if (sortOrder === "oldest") {
    allPosts.reverse();
  }

  // Fetch parent posts if needed
  if (includeParents) {
    const parentUris = [...new Set(
      allPosts
        .map((p) => p.replyParent)
        .filter(Boolean)
    )] as string[];

    const parentMap: Record<string, BlueskyPost> = {};

    // Process parents in batches
    const batchSize = 25;
    for (let i = 0; i < parentUris.length; i += batchSize) {
      const batch = parentUris.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (uri) => {
          try {
            await rateLimiter.waitForSlot("bsky:getPostThread");
            const res = await agent.getPostThread({ uri, depth: 0 });
            if (res.data.thread && "post" in res.data.thread) {
              return [uri, transformBskyPost({ post: res.data.thread.post })] as const;
            }
            return [uri, null] as const;
          } catch (err) {
            console.error(`Failed to fetch parent post ${uri}:`, err);
            return [uri, null] as const;
          }
        })
      );

      results.forEach(([uri, post]) => {
        if (post) parentMap[uri] = post;
      });
    }

    allPosts.forEach((p) => {
      if (p.replyParent && parentMap[p.replyParent]) {
        p.parentPost = parentMap[p.replyParent];
      }
    });
  }

  return fetchAll ? allPosts : allPosts.slice(0, limit);
}

// Main Bluesky fetch function
async function fetchBskyUserData(
  handleOrDid: string,
  params: BlueskyQueryParams,
  serviceUrl: string
): Promise<BlueskyResponse & { params?: BlueskyQueryParams }> {
  const agent = getBskyClient(serviceUrl);

  // Resolve handle to DID if needed
  const actor = handleOrDid.startsWith("did:")
    ? handleOrDid
    : await resolveBskyHandle(handleOrDid, serviceUrl);

  // Get profile
  const profileRes = await agent.getProfile({ actor });
  const user = transformBskyUser(profileRes.data);

  // Get posts
  const posts = await fetchBskyPosts(actor, params, serviceUrl);

  return { user, posts, params };
}

// Format Bluesky output as text
function formatBskyTextOutput(data: BlueskyResponse & { params?: BlueskyQueryParams }): string {
  const { user, posts, params } = data;
  const includeReactions = params?.includeReactions === true;

  let out = `Bluesky User Profile\n====================\n\n`;
  out += `Handle: @${user.handle}\n`;
  out += `Display Name: ${user.displayName || "N/A"}\n`;
  out += `DID: ${user.did}\n`;
  if (user.description) out += `Bio: ${user.description}\n`;
  if (user.avatar) out += `Avatar: ${user.avatar}\n`;
  if (user.postsCount !== undefined) out += `Posts: ${user.postsCount}\n`;
  if (user.followersCount !== undefined) out += `Followers: ${user.followersCount}\n`;
  if (user.followsCount !== undefined) out += `Following: ${user.followsCount}\n`;
  out += `\nPosts\n=====\n\n`;

  if (!posts.length) {
    out += "No posts found.\n";
  } else {
    posts.forEach((post, i) => {
      out += `[${i + 1}] ${post.createdAt}\n`;
      if (post.replyParent) out += `\n[Reply]\n`;
      out += `${post.text}\n`;

      if (includeReactions) {
        out += `\nReactions:\n`;
        out += `- Likes: ${post.likeCount}\n`;
        out += `- Reposts: ${post.repostCount}\n`;
        out += `- Replies: ${post.replyCount}\n`;
        out += `- Quotes: ${post.quoteCount}\n`;
      }

      const embeds = post.embeds?.filter((e) => e?.url) || [];
      if (embeds.length) {
        out += `\nEmbeds:\n${embeds.map((e) => `- ${e.url}`).join("\n")}\n`;
      }
      out += `\n---\n\n`;
    });
  }

  return out;
}

// App
const app = new Hono<{ Bindings: Bindings }>();

// Dynamic CORS middleware - reads allowed origins from CORS_ORIGIN env var
app.use("/*", async (c, next) => {
  const allowedOrigins = c.env.CORS_ORIGIN?.split(",") || [];
  const origin = c.req.header("Origin") || "";

  const corsMiddleware = cors({
    origin: allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "",
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "Accept", "X-PAYMENT"],
    exposeHeaders: ["X-PAYMENT-RESPONSE"],
    maxAge: 86400,
  });

  return corsMiddleware(c, next);
});

// Lazy-initialized x402 server (avoids global scope async in Cloudflare Workers)
let x402ServerInstance: x402ResourceServer | null = null;
let lastFacilitatorConfig: string | null = null;

interface FacilitatorConfig {
  url: string;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
}

function getX402Server(config: FacilitatorConfig): x402ResourceServer {
  const configKey = `${config.url}:${config.cdpApiKeyId || ""}`;

  if (!x402ServerInstance || lastFacilitatorConfig !== configKey) {
    // Create auth headers function for CDP facilitator authentication using JWT
    const createAuthHeaders = config.cdpApiKeyId && config.cdpApiKeySecret
      ? async () => {
          const host = "api.cdp.coinbase.com";

          // Generate JWTs for each endpoint
          const [verifyJwt, settleJwt, supportedJwt] = await Promise.all([
            generateJwt({
              apiKeyId: config.cdpApiKeyId!,
              apiKeySecret: config.cdpApiKeySecret!,
              requestMethod: "POST",
              requestHost: host,
              requestPath: "/platform/v2/x402/verify",
            }),
            generateJwt({
              apiKeyId: config.cdpApiKeyId!,
              apiKeySecret: config.cdpApiKeySecret!,
              requestMethod: "POST",
              requestHost: host,
              requestPath: "/platform/v2/x402/settle",
            }),
            generateJwt({
              apiKeyId: config.cdpApiKeyId!,
              apiKeySecret: config.cdpApiKeySecret!,
              requestMethod: "GET",
              requestHost: host,
              requestPath: "/platform/v2/x402/supported",
            }),
          ]);

          return {
            verify: { Authorization: `Bearer ${verifyJwt}` },
            settle: { Authorization: `Bearer ${settleJwt}` },
            supported: { Authorization: `Bearer ${supportedJwt}` },
          };
        }
      : undefined;

    const facilitatorClient = new HTTPFacilitatorClient({
      url: config.url,
      createAuthHeaders,
    });
    x402ServerInstance = new x402ResourceServer(facilitatorClient);
    registerExactEvmScheme(x402ServerInstance);
    x402ServerInstance.registerExtension(bazaarResourceServerExtension);
    lastFacilitatorConfig = configKey;
  }
  return x402ServerInstance;
}

// x402 payment middleware using @x402/hono v2 API
app.use("/", async (c, next) => {
  const query = c.req.query();

  // Skip: no query params (redirect to frontend)
  if (!Object.keys(query).length) {
    return next();
  }

  const payTo = c.env.X402_PAY_TO;
  const network = (c.env.X402_NETWORK || "eip155:84532") as Network;
  const facilitatorUrl = c.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
  const basePrice = c.env.X402_BASE_PRICE || "$0.001";

  if (!payTo) return next();

  // Calculate dynamic price based on query params
  const pricingParams: PricingParams = {
    limit: query.limit ? Number(query.limit) : undefined,
    all: String(query.all).toLowerCase() === "true",
    includeReplies: String(query.includeReplies).toLowerCase() === "true",
    includeParents: String(query.includeParents).toLowerCase() === "true",
    includeReactions: String(query.includeReactions).toLowerCase() === "true",
  };

  // Skip payment for free tier
  if (isFreeTier(pricingParams)) {
    return next();
  }

  // For "all" queries, fetch actual cast count for accurate pricing
  let castCount: number | null = null;
  if (pricingParams.all) {
    try {
      const fid = query.fid;
      const username = query.username;
      let userFid: number | null = null;

      if (fid) {
        userFid = parseInt(fid as string, 10);
      } else if (username) {
        const cleanUsername = (username as string).toLowerCase().replace(/^@/, "");
        const cacheKey = `user:${cleanUsername}`;
        const cached = getCached<number>(cacheKey);
        if (cached) {
          userFid = cached;
        } else {
          const client = getClient(c.env.NEYNAR_API_KEY);
          const userResponse = await client.lookupUserByUsername({ username: cleanUsername });
          if (userResponse?.user?.fid) {
            userFid = userResponse.user.fid;
            setCache(cacheKey, userFid, 300000);
          }
        }
      }

      if (userFid) {
        const storageCacheKey = `storage:${userFid}`;
        castCount = getCached<number>(storageCacheKey);
        if (castCount === null) {
          const client = getClient(c.env.NEYNAR_API_KEY);
          const storageResponse = await client.lookupUserStorageUsage({ fid: userFid });
          castCount = storageResponse?.casts?.used ?? null;
          if (castCount !== null) {
            setCache(storageCacheKey, castCount, 60000);
          }
        }
      }
    } catch (err) {
      console.error("Failed to fetch cast count for pricing:", err);
    }
  }

  const dynamicPrice = calculateDynamicPriceWithCastCount(pricingParams, castCount, parseDollarPrice(basePrice));
  const server = getX402Server({
    url: facilitatorUrl,
    cdpApiKeyId: c.env.CDP_API_KEY_ID,
    cdpApiKeySecret: c.env.CDP_API_KEY_SECRET,
  });

  // Use @x402/hono v2 API
  const middleware = paymentMiddleware(
    {
      "GET /": {
        accepts: [
          {
            scheme: "exact",
            price: dynamicPrice,
            network,
            payTo,
          },
        ],
        description: `Farcaster profile export - ${dynamicPrice}`,
        mimeType: "text/plain",
        extensions: {
          ...declareDiscoveryExtension({
            input: { username: "vitalik.eth", limit: 50 },
            inputSchema: {
              properties: {
                fid: { type: "number", description: "Farcaster ID of the user" },
                username: { type: "string", description: "Farcaster username (without @)" },
                limit: { type: "number", description: "Maximum number of casts to return (default: 50)" },
                sortOrder: { type: "string", enum: ["newest", "oldest"], description: "Sort order for casts" },
                includeReplies: { type: "boolean", description: "Include reply casts" },
                includeParents: { type: "boolean", description: "Include parent casts for replies" },
                includeReactions: { type: "boolean", description: "Include reaction counts in output" },
                all: { type: "boolean", description: "Fetch all casts (ignores limit)" },
              },
            },
            output: {
              example: "Farcaster User Profile\n===================\n\nUsername: vitalik.eth\nDisplay Name: Vitalik Buterin\nFID: 5650\nBio: Ethereum co-founder\n\nPosts\n=====\n\n[1] 2024-01-15T12:00:00Z\nHello Farcaster!\n\n---",
              schema: {
                type: "string",
                description: "Plain text formatted Farcaster profile and casts export",
              },
            },
          }),
        },
      },
    },
    server
  );

  return middleware(c, next);
});

// Pricing info endpoint - returns pricing configuration for all services
// Used by frontends to display accurate pricing tables
app.get("/pricing", async (c) => {
  const basePrice = c.env.X402_BASE_PRICE || "$0.001";

  return c.json({
    farcaster: {
      freeTier: { maxCasts: FREE_TIER.maxLimit, description: "Up to 10 casts (basic)" },
      examples: [
        { description: "50 casts", cost: "$0.001" },
        { description: "500 casts", cost: "$0.004" },
        { description: "5,000 casts", cost: "$0.034" },
      ],
      modifiers: [
        { feature: "includeReplies", effect: "+25%", description: "Include reply casts" },
        { feature: "includeReactions", effect: "+10%", description: "Include reaction counts" },
        { feature: "includeParents", effect: "+60% per cast", description: "Fetch parent context for replies" },
      ],
      note: "Pricing scales with data volume. Parent lookups add significant cost for large exports.",
    },
    bluesky: {
      freeTier: { maxPosts: FREE_TIER.maxLimit, description: "Up to 10 posts (basic)" },
      examples: [
        { description: "50 posts", cost: "$0.001" },
        { description: "500 posts", cost: "$0.004" },
        { description: "5,000 posts", cost: "$0.034" },
      ],
      modifiers: [
        { feature: "includeReplies", effect: "+25%", description: "Include reply posts" },
        { feature: "includeReactions", effect: "+10%", description: "Include reaction counts" },
        { feature: "includeParents", effect: "+60% per post", description: "Fetch parent context for replies" },
      ],
      note: "Pricing scales with data volume. Parent lookups add significant cost for large exports.",
    },
    rss: {
      freeTier: { maxItems: RSS_PRICING.freeTierMaxItems, description: "Up to 5 items (summaries)" },
      examples: [
        { description: "10 items", cost: "$0.001" },
        { description: "50 items", cost: "$0.003" },
        { description: "100 items", cost: "$0.006" },
      ],
      modifiers: [
        { feature: "includeContent", effect: "+50%", description: "Include full article content" },
      ],
      note: "Pricing scales with number of feed items exported.",
    },
    git: {
      freeTier: { description: "Metadata only, or file tree for small repos (≤10 files)" },
      examples: [
        { description: "File tree only (100 files)", cost: "$0.001" },
        { description: "With content (1MB repo)", cost: "~$0.02" },
        { description: "With content (10MB repo)", cost: "~$0.15" },
      ],
      modifiers: [
        { feature: "includePatterns", effect: "Reduces cost", description: "Filter to specific files" },
        { feature: "excludePatterns", effect: "Reduces cost", description: "Exclude files from export" },
        { feature: "maxFileSize", effect: "Reduces cost", description: "Limit file size for content" },
      ],
      note: "Pricing scales with output size. Using filters significantly reduces cost.",
    },
    basePrice,
    currency: "USD",
  });
});

// Price estimate endpoint - returns authoritative price from server
// This endpoint is free (no payment required)
app.get("/estimate", async (c) => {
  try {
    const fid = c.req.query("fid");
    const username = c.req.query("username");

    if (!fid && !username) {
      return c.json({ error: "fid or username required" }, 400);
    }

    const client = getClient(c.env.NEYNAR_API_KEY);

    // Parse query params
    const params: PricingParams = {
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      all: c.req.query("all") === "true",
      includeReplies: c.req.query("includeReplies") === "true",
      includeParents: c.req.query("includeParents") === "true",
      includeReactions: c.req.query("includeReactions") === "true",
    };

    // Check free tier first
    if (isFreeTier(params)) {
      return c.json({
        price: "$0",
        isFree: true,
        castCount: null,
      });
    }

    // For "all" queries, we need the actual cast count
    let castCount: number | null = null;

    if (params.all) {
      // Resolve username to FID if needed
      let userFid: number;

      if (fid) {
        userFid = parseInt(fid, 10);
      } else {
        const cleanUsername = username!.toLowerCase().replace(/^@/, "");
        const cacheKey = `user:${cleanUsername}`;
        const cached = getCached<number>(cacheKey);

        if (cached) {
          userFid = cached;
        } else {
          try {
            const userResponse = await client.lookupUserByUsername({ username: cleanUsername });
            if (!userResponse?.user?.fid) {
              return c.json({ error: "User not found" }, 404);
            }
            userFid = userResponse.user.fid;
            setCache(cacheKey, userFid, 300000);
          } catch {
            return c.json({ error: "User not found" }, 404);
          }
        }
      }

      // Get storage usage to get cast count
      const storageCacheKey = `storage:${userFid}`;
      castCount = getCached<number>(storageCacheKey);

      if (castCount === null) {
        try {
          const storageResponse = await client.lookupUserStorageUsage({ fid: userFid });
          castCount = storageResponse?.casts?.used ?? 0;
          setCache(storageCacheKey, castCount, 60000);
        } catch {
          castCount = 0;
        }
      }
    }

    // Calculate price using actual cast count for "all"
    const price = calculateDynamicPriceWithCastCount(
      params,
      castCount,
      parseDollarPrice(c.env.X402_BASE_PRICE || "$0.001")
    );

    return c.json({
      price,
      isFree: false,
      castCount,
    });
  } catch (error) {
    console.error("Estimate error:", error);
    return c.json({ error: "Failed to calculate estimate" }, 500);
  }
});

// User info endpoint - returns cast count for accurate "all" pricing
// This endpoint is free (no payment required)
app.get("/user-info", async (c) => {
  try {
    const fid = c.req.query("fid");
    const username = c.req.query("username");

    if (!fid && !username) {
      return c.json({ error: "fid or username required" }, 400);
    }

    const client = getClient(c.env.NEYNAR_API_KEY);

    // Resolve username to FID if needed
    let userFid: number;

    if (fid) {
      userFid = parseInt(fid, 10);
      if (isNaN(userFid) || userFid <= 0) {
        return c.json({ error: "Invalid FID" }, 400);
      }
    } else {
      // Look up user by username
      const cleanUsername = username!.toLowerCase().replace(/^@/, "");
      const cacheKey = `user:${cleanUsername}`;
      const cached = getCached<number>(cacheKey);

      if (cached) {
        userFid = cached;
      } else {
        try {
          const userResponse = await client.lookupUserByUsername({ username: cleanUsername });
          if (!userResponse?.user?.fid) {
            return c.json({ error: "User not found" }, 404);
          }
          userFid = userResponse.user.fid;
          setCache(cacheKey, userFid, 300000); // 5 minute cache
        } catch {
          return c.json({ error: "User not found" }, 404);
        }
      }
    }

    // Get storage usage to get cast count
    const storageCacheKey = `storage:${userFid}`;
    let castCount = getCached<number>(storageCacheKey);

    if (castCount === null) {
      try {
        const storageResponse = await client.lookupUserStorageUsage({ fid: userFid });
        castCount = storageResponse?.casts?.used ?? 0;
        setCache(storageCacheKey, castCount, 60000); // 1 minute cache
      } catch {
        castCount = 0;
      }
    }

    return c.json({
      fid: userFid,
      castCount,
    });
  } catch (error) {
    console.error("User info error:", error);
    return c.json({ error: "Failed to fetch user info" }, 500);
  }
});

app.get("/", async (c) => {
  try {
    const q = c.req.query() as FarcasterQueryParams;

    if (!Object.keys(q).length) return c.redirect("https://llm-fid.fun");
    if (!q.fid && !q.username) return c.text("fid or username required", 400);

    // Parse params
    if (q.fid) {
      const n = Number(q.fid);
      if (isNaN(n) || n <= 0) return c.text("Invalid FID", 400);
      q.fid = n;
    }
    if (q.limit && (isNaN(Number(q.limit)) || Number(q.limit) <= 0)) {
      return c.text("Invalid limit", 400);
    }
    if (q.sortOrder && !["newest", "oldest"].includes(q.sortOrder)) {
      return c.text("Invalid sortOrder (must be 'newest' or 'oldest')", 400);
    }

    // Boolean params
    q.all = String(q.all).toLowerCase() === "true";
    q.includeReplies = String(q.includeReplies).toLowerCase() === "true";
    q.includeParents = String(q.includeParents).toLowerCase() === "true";
    q.includeReactions = String(q.includeReactions).toLowerCase() === "true";

    // Normalize username
    if (q.username) {
      q.username = q.username.toLowerCase().replace(/^@/, "");
    }

    const data = await fetchUserData(q.fid || q.username || "", q, c.env.NEYNAR_API_KEY);

    c.header("Content-Type", "text/plain");
    return c.text(formatTextOutput(data));
  } catch (err) {
    console.error(err);
    return c.text(`Error: ${err instanceof Error ? err.message : "Unknown"}`, 500);
  }
});

// ============================================================
// BLUESKY ROUTES
// ============================================================

// Bluesky estimate endpoint
app.get("/bsky/estimate", async (c) => {
  try {
    const handle = c.req.query("handle");
    const did = c.req.query("did");

    if (!handle && !did) {
      return c.json({ error: "handle or did required" }, 400);
    }

    const params: PricingParams = {
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      all: c.req.query("all") === "true",
      includeReplies: c.req.query("includeReplies") === "true",
      includeParents: c.req.query("includeParents") === "true",
      includeReactions: c.req.query("includeReactions") === "true",
    };

    if (isFreeTier(params)) {
      return c.json({ price: "$0", isFree: true, postCount: null });
    }

    // Get post count for accurate "all" pricing
    let postCount: number | null = null;
    if (params.all) {
      try {
        const agent = getBskyClient(c.env.BSKY_SERVICE_URL);
        const actor = did || handle!.toLowerCase().replace(/^@/, "");
        const profile = await agent.getProfile({ actor });
        postCount = profile.data.postsCount ?? null;
      } catch (err) {
        console.error("Failed to fetch post count:", err);
      }
    }

    const price = calculateDynamicPriceWithCastCount(
      params,
      postCount,
      parseDollarPrice(c.env.X402_BASE_PRICE || "$0.001")
    );

    return c.json({ price, isFree: false, postCount });
  } catch (error) {
    console.error("Bluesky estimate error:", error);
    return c.json({ error: "Failed to calculate estimate" }, 500);
  }
});

// Bluesky user info endpoint
app.get("/bsky/user-info", async (c) => {
  try {
    const handle = c.req.query("handle");
    const did = c.req.query("did");

    if (!handle && !did) {
      return c.json({ error: "handle or did required" }, 400);
    }

    const agent = getBskyClient(c.env.BSKY_SERVICE_URL);
    const actor = did || handle!.toLowerCase().replace(/^@/, "");
    const profile = await agent.getProfile({ actor });

    return c.json({
      did: profile.data.did,
      handle: profile.data.handle,
      postCount: profile.data.postsCount ?? 0,
    });
  } catch (error) {
    console.error("Bluesky user info error:", error);
    return c.json({ error: "Failed to fetch user info" }, 500);
  }
});

// Bluesky payment middleware
app.use("/bsky", async (c, next) => {
  const query = c.req.query();

  // Skip: no query params (redirect to frontend)
  if (!Object.keys(query).length) {
    return next();
  }

  const payTo = c.env.X402_PAY_TO;
  const network = (c.env.X402_NETWORK || "eip155:84532") as Network;
  const facilitatorUrl = c.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
  const basePrice = c.env.X402_BASE_PRICE || "$0.001";

  if (!payTo) return next();

  const pricingParams: PricingParams = {
    limit: query.limit ? Number(query.limit) : undefined,
    all: String(query.all).toLowerCase() === "true",
    includeReplies: String(query.includeReplies).toLowerCase() === "true",
    includeParents: String(query.includeParents).toLowerCase() === "true",
    includeReactions: String(query.includeReactions).toLowerCase() === "true",
  };

  // Skip payment for free tier
  if (isFreeTier(pricingParams)) {
    return next();
  }

  // For "all" queries, fetch actual post count for accurate pricing
  let postCount: number | null = null;
  if (pricingParams.all) {
    try {
      const agent = getBskyClient(c.env.BSKY_SERVICE_URL);
      const actor = query.did || query.handle?.toLowerCase().replace(/^@/, "");
      if (actor) {
        const profile = await agent.getProfile({ actor });
        postCount = profile.data.postsCount ?? null;
      }
    } catch (err) {
      console.error("Failed to fetch post count for pricing:", err);
    }
  }

  const dynamicPrice = calculateDynamicPriceWithCastCount(pricingParams, postCount, parseDollarPrice(basePrice));
  const server = getX402Server({
    url: facilitatorUrl,
    cdpApiKeyId: c.env.CDP_API_KEY_ID,
    cdpApiKeySecret: c.env.CDP_API_KEY_SECRET,
  });

  const middleware = paymentMiddleware(
    {
      "GET /bsky": {
        accepts: [
          {
            scheme: "exact",
            price: dynamicPrice,
            network,
            payTo,
          },
        ],
        description: `Bluesky profile export - ${dynamicPrice}`,
        mimeType: "text/plain",
        extensions: {
          ...declareDiscoveryExtension({
            input: { handle: "jay.bsky.team", limit: 50 },
            inputSchema: {
              properties: {
                handle: { type: "string", description: "Bluesky handle (without @)" },
                did: { type: "string", description: "Bluesky DID (decentralized identifier)" },
                limit: { type: "number", description: "Maximum number of posts to return (default: 50)" },
                sortOrder: { type: "string", enum: ["newest", "oldest"], description: "Sort order for posts" },
                includeReplies: { type: "boolean", description: "Include reply posts" },
                includeParents: { type: "boolean", description: "Include parent posts for replies" },
                includeReactions: { type: "boolean", description: "Include reaction counts in output" },
                all: { type: "boolean", description: "Fetch all posts (ignores limit)" },
              },
            },
            output: {
              example: "Bluesky User Profile\n====================\n\nHandle: @jay.bsky.team\nDisplay Name: Jay\nDID: did:plc:abc123\nBio: Building Bluesky\n\nPosts\n=====\n\n[1] 2024-01-15T12:00:00Z\nHello Bluesky!\n\n---",
              schema: {
                type: "string",
                description: "Plain text formatted Bluesky profile and posts export",
              },
            },
          }),
        },
      },
    },
    server
  );

  return middleware(c, next);
});

// Bluesky main endpoint
app.get("/bsky", async (c) => {
  try {
    const q = c.req.query() as BlueskyQueryParams;

    if (!Object.keys(q).length) return c.redirect("https://llm-bsky.fun");
    if (!q.handle && !q.did) return c.text("handle or did required", 400);

    // Validate params
    if (q.limit && (isNaN(Number(q.limit)) || Number(q.limit) <= 0)) {
      return c.text("Invalid limit", 400);
    }
    if (q.sortOrder && !["newest", "oldest"].includes(q.sortOrder)) {
      return c.text("Invalid sortOrder (must be 'newest' or 'oldest')", 400);
    }

    // Boolean params
    q.all = String(q.all).toLowerCase() === "true" as any;
    q.includeReplies = String(q.includeReplies).toLowerCase() === "true" as any;
    q.includeParents = String(q.includeParents).toLowerCase() === "true" as any;
    q.includeReactions = String(q.includeReactions).toLowerCase() === "true" as any;

    // Normalize handle
    if (q.handle) {
      q.handle = q.handle.toLowerCase().replace(/^@/, "");
    }

    const data = await fetchBskyUserData(
      q.did || q.handle || "",
      q,
      c.env.BSKY_SERVICE_URL
    );

    c.header("Content-Type", "text/plain");
    return c.text(formatBskyTextOutput(data));
  } catch (err) {
    console.error(err);
    return c.text(`Error: ${err instanceof Error ? err.message : "Unknown"}`, 500);
  }
});

// ============================================================
// RSS/ATOM SUPPORT
// ============================================================

// RSS pricing configuration
const RSS_PRICING = {
  baseFetch: 0.0005, // Base cost for fetching feed
  perItem: 0.00005, // Cost per item
  contentMultiplier: 1.5, // Multiplier when including full content
  freeTierMaxItems: 5, // Free tier limit
};

interface RssPricingParams {
  itemCount?: number;
  includeContent?: boolean;
  all?: boolean;
}

function isRssFreeTier(params: RssPricingParams): boolean {
  if (params.all) return false;
  if (params.includeContent) return false;
  const itemCount = params.itemCount || 10;
  return itemCount <= RSS_PRICING.freeTierMaxItems;
}

function calculateRssPrice(params: RssPricingParams, basePrice: number): string {
  if (isRssFreeTier(params)) return "$0";

  const itemCount = params.itemCount || 10;
  let cost = RSS_PRICING.baseFetch + (itemCount * RSS_PRICING.perItem);

  if (params.includeContent) {
    cost *= RSS_PRICING.contentMultiplier;
  }

  cost = Math.max(cost, basePrice);
  const rounded = Math.round(cost * 1000000) / 1000000;
  return `$${rounded}`;
}

// Parse RSS/Atom feed using regex (works in Workers without DOM)
function parseRssFeed(xml: string): { feed: RssFeed; items: RssItem[] } {
  const isAtom = xml.includes("<feed") && xml.includes("xmlns=\"http://www.w3.org/2005/Atom\"");

  if (isAtom) {
    return parseAtomFeed(xml);
  }
  return parseRss2Feed(xml);
}

function parseRss2Feed(xml: string): { feed: RssFeed; items: RssItem[] } {
  const getTagContent = (text: string, tag: string): string | undefined => {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const match = text.match(regex);
    return match?.[1]?.trim().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  };

  const channelMatch = xml.match(/<channel[^>]*>([\s\S]*?)<\/channel>/i);
  const channelContent = channelMatch?.[1] ?? xml;

  // Extract items
  const itemMatches = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
  const items: RssItem[] = itemMatches.map((itemXml) => {
    const categories: string[] = [];
    const catMatches = itemXml.match(/<category[^>]*>([^<]*)<\/category>/gi) || [];
    catMatches.forEach((cat) => {
      const content = cat.replace(/<\/?category[^>]*>/gi, "").trim();
      if (content) categories.push(content.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
    });

    const enclosureMatch = itemXml.match(/<enclosure([^>]*)\/?\s*>/i);
    let enclosure: RssItem["enclosure"] | undefined;
    if (enclosureMatch && enclosureMatch[1]) {
      const attrs = enclosureMatch[1];
      const urlMatch = attrs.match(/url="([^"]*)"/);
      const typeMatch = attrs.match(/type="([^"]*)"/);
      const lengthMatch = attrs.match(/length="([^"]*)"/);
      if (urlMatch && urlMatch[1]) {
        enclosure = {
          url: urlMatch[1],
          type: typeMatch?.[1],
          length: lengthMatch?.[1] ? parseInt(lengthMatch[1], 10) : undefined,
        };
      }
    }

    return {
      title: getTagContent(itemXml, "title") || "",
      link: getTagContent(itemXml, "link") || "",
      description: getTagContent(itemXml, "description"),
      content: getTagContent(itemXml, "content:encoded") || getTagContent(itemXml, "content"),
      pubDate: getTagContent(itemXml, "pubDate"),
      author: getTagContent(itemXml, "author") || getTagContent(itemXml, "dc:creator"),
      categories: categories.length > 0 ? categories : undefined,
      guid: getTagContent(itemXml, "guid"),
      enclosure,
    };
  });

  const feed: RssFeed = {
    title: getTagContent(channelContent, "title") || "",
    description: getTagContent(channelContent, "description"),
    link: getTagContent(channelContent, "link") || "",
    language: getTagContent(channelContent, "language"),
    lastBuildDate: getTagContent(channelContent, "lastBuildDate"),
    generator: getTagContent(channelContent, "generator"),
    itemCount: items.length,
  };

  return { feed, items };
}

function parseAtomFeed(xml: string): { feed: RssFeed; items: RssItem[] } {
  const getTagContent = (text: string, tag: string): string | undefined => {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const match = text.match(regex);
    return match?.[1]?.trim().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  };

  const getAttrValue = (text: string, tag: string, attr: string): string | undefined => {
    const regex = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*>`, "i");
    const match = text.match(regex);
    return match ? match[1] : undefined;
  };

  // Get feed-level link (href attribute)
  const feedLinkMatch = xml.match(/<link[^>]*rel="alternate"[^>]*href="([^"]*)"[^>]*\/?>/i) ||
                        xml.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i);
  const feedLink = feedLinkMatch?.[1] ?? "";

  const entryMatches = xml.match(/<entry[^>]*>[\s\S]*?<\/entry>/gi) || [];
  const items: RssItem[] = entryMatches.map((entryXml) => {
    const linkMatch = entryXml.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i);
    const categories: string[] = [];
    const catMatches = entryXml.match(/<category[^>]*term="([^"]*)"[^>]*\/?>/gi) || [];
    catMatches.forEach((cat) => {
      const termMatch = cat.match(/term="([^"]*)"/);
      if (termMatch?.[1]) categories.push(termMatch[1]);
    });

    return {
      title: getTagContent(entryXml, "title") || "",
      link: linkMatch?.[1] ?? "",
      description: getTagContent(entryXml, "summary"),
      content: getTagContent(entryXml, "content"),
      pubDate: getTagContent(entryXml, "published") || getTagContent(entryXml, "updated"),
      author: getTagContent(entryXml, "name"), // Inside <author><name>
      categories: categories.length > 0 ? categories : undefined,
      guid: getTagContent(entryXml, "id"),
    };
  });

  const feed: RssFeed = {
    title: getTagContent(xml, "title") || "",
    description: getTagContent(xml, "subtitle"),
    link: feedLink,
    language: getAttrValue(xml, "feed", "xml:lang"),
    lastBuildDate: getTagContent(xml, "updated"),
    generator: getTagContent(xml, "generator"),
    itemCount: items.length,
  };

  return { feed, items };
}

async function fetchRssFeed(url: string, params: RssQueryParams): Promise<RssResponse & { params?: RssQueryParams }> {
  await rateLimiter.waitForSlot("rss:fetch");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "LLM-RSS-Bot/1.0 (+https://llm-rss.fun)",
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feed: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const { feed, items: allItems } = parseRssFeed(xml);

  // Apply limits and sorting
  let items = [...allItems];

  if (params.sortOrder === "oldest") {
    items.reverse();
  }

  if (!params.all && params.limit) {
    items = items.slice(0, params.limit);
  }

  // Strip content if not requested
  if (!params.includeContent) {
    items = items.map((item) => ({ ...item, content: undefined }));
  }

  return { feed, items, params };
}

function formatRssTextOutput(data: RssResponse & { params?: RssQueryParams }): string {
  const { feed, items, params } = data;
  const includeContent = params?.includeContent === true;

  let out = `RSS Feed\n========\n\n`;
  out += `Title: ${feed.title}\n`;
  if (feed.description) out += `Description: ${feed.description}\n`;
  out += `Link: ${feed.link}\n`;
  if (feed.language) out += `Language: ${feed.language}\n`;
  if (feed.lastBuildDate) out += `Last Updated: ${feed.lastBuildDate}\n`;
  if (feed.generator) out += `Generator: ${feed.generator}\n`;
  out += `Items: ${feed.itemCount}\n`;
  out += `\nItems\n=====\n\n`;

  if (!items.length) {
    out += "No items found.\n";
  } else {
    items.forEach((item, i) => {
      out += `[${i + 1}] ${item.title}\n`;
      if (item.pubDate) out += `Date: ${item.pubDate}\n`;
      if (item.author) out += `Author: ${item.author}\n`;
      out += `Link: ${item.link}\n`;
      if (item.categories?.length) out += `Categories: ${item.categories.join(", ")}\n`;
      if (item.description) out += `\nSummary:\n${item.description}\n`;
      if (includeContent && item.content) out += `\nContent:\n${item.content}\n`;
      if (item.enclosure) out += `\nEnclosure: ${item.enclosure.url}\n`;
      out += `\n---\n\n`;
    });
  }

  return out;
}

// RSS estimate endpoint
app.get("/rss/estimate", async (c) => {
  try {
    const url = c.req.query("url");
    if (!url) {
      return c.json({ error: "url required" }, 400);
    }

    const params: RssPricingParams = {
      itemCount: c.req.query("limit") ? Number(c.req.query("limit")) : 10,
      all: c.req.query("all") === "true",
      includeContent: c.req.query("includeContent") === "true",
    };

    if (isRssFreeTier(params)) {
      return c.json({ price: "$0", isFree: true, itemCount: null });
    }

    // Fetch feed to get actual item count for "all" queries
    let itemCount: number | null = null;
    if (params.all) {
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "LLM-RSS-Bot/1.0 (+https://llm-rss.fun)",
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
          },
        });
        if (response.ok) {
          const xml = await response.text();
          const { feed } = parseRssFeed(xml);
          itemCount = feed.itemCount;
          params.itemCount = itemCount;
        }
      } catch (err) {
        console.error("Failed to fetch feed for estimate:", err);
      }
    }

    const price = calculateRssPrice(params, parseDollarPrice(c.env.X402_BASE_PRICE || "$0.001"));
    return c.json({ price, isFree: false, itemCount });
  } catch (error) {
    console.error("RSS estimate error:", error);
    return c.json({ error: "Failed to calculate estimate" }, 500);
  }
});

// RSS payment middleware
app.use("/rss", async (c, next) => {
  const query = c.req.query();
  if (!Object.keys(query).length || !query.url) {
    return next();
  }

  const payTo = c.env.X402_PAY_TO;
  const network = (c.env.X402_NETWORK || "eip155:84532") as Network;
  const facilitatorUrl = c.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
  const basePrice = c.env.X402_BASE_PRICE || "$0.001";

  if (!payTo) return next();

  const pricingParams: RssPricingParams = {
    itemCount: query.limit ? Number(query.limit) : 10,
    all: String(query.all).toLowerCase() === "true",
    includeContent: String(query.includeContent).toLowerCase() === "true",
  };

  if (isRssFreeTier(pricingParams)) {
    return next();
  }

  // For "all" queries, fetch actual item count
  if (pricingParams.all) {
    try {
      const response = await fetch(query.url, {
        headers: {
          "User-Agent": "LLM-RSS-Bot/1.0 (+https://llm-rss.fun)",
          "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
        },
      });
      if (response.ok) {
        const xml = await response.text();
        const { feed } = parseRssFeed(xml);
        pricingParams.itemCount = feed.itemCount;
      }
    } catch (err) {
      console.error("Failed to fetch feed for pricing:", err);
    }
  }

  const dynamicPrice = calculateRssPrice(pricingParams, parseDollarPrice(basePrice));
  const server = getX402Server({
    url: facilitatorUrl,
    cdpApiKeyId: c.env.CDP_API_KEY_ID,
    cdpApiKeySecret: c.env.CDP_API_KEY_SECRET,
  });

  const middleware = paymentMiddleware(
    {
      "GET /rss": {
        accepts: [{ scheme: "exact", price: dynamicPrice, network, payTo }],
        description: `RSS feed export - ${dynamicPrice}`,
        mimeType: "text/plain",
        extensions: {
          ...declareDiscoveryExtension({
            input: { url: "https://example.com/feed.xml", limit: 10 },
            inputSchema: {
              properties: {
                url: { type: "string", description: "URL of the RSS/Atom feed to fetch" },
                limit: { type: "number", description: "Maximum number of items to return (default: 10)" },
                sortOrder: { type: "string", enum: ["newest", "oldest"], description: "Sort order for items" },
                includeContent: { type: "boolean", description: "Include full content of items" },
                all: { type: "boolean", description: "Fetch all items (ignores limit)" },
              },
              required: ["url"],
            },
            output: {
              example: "RSS Feed\n========\n\nTitle: Example Blog\nDescription: A sample blog\nLink: https://example.com\nItems: 10\n\nItems\n=====\n\n[1] Example Post\nDate: 2024-01-15\nLink: https://example.com/post-1\n\nSummary:\nThis is the post summary...\n\n---",
              schema: {
                type: "string",
                description: "Plain text formatted RSS/Atom feed export",
              },
            },
          }),
        },
      },
    },
    server
  );

  return middleware(c, next);
});

// RSS main endpoint
app.get("/rss", async (c) => {
  try {
    const url = c.req.query("url");
    if (!url) {
      if (!Object.keys(c.req.query()).length) return c.redirect("https://llm-rss.fun");
      return c.text("url required", 400);
    }

    const q: RssQueryParams = {
      url,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : 10,
      all: String(c.req.query("all")).toLowerCase() === "true",
      includeContent: String(c.req.query("includeContent")).toLowerCase() === "true",
      sortOrder: (c.req.query("sortOrder") as "newest" | "oldest") || "newest",
    };

    const data = await fetchRssFeed(url, q);

    c.header("Content-Type", "text/plain");
    return c.text(formatRssTextOutput(data));
  } catch (err) {
    console.error(err);
    return c.text(`Error: ${err instanceof Error ? err.message : "Unknown"}`, 500);
  }
});

// ============================================================
// GIT REPOSITORY SUPPORT
// ============================================================

// Pattern matching utilities for Git filtering
function matchesPatterns(
  filePath: string,
  includePatterns?: string[],
  excludePatterns?: string[]
): boolean {
  // If no include patterns, include everything by default
  let included = true;
  if (includePatterns && includePatterns.length > 0) {
    included = includePatterns.some(pattern =>
      picomatch.isMatch(filePath, pattern, { dot: true })
    );
  }

  if (!included) return false;

  // Apply exclude patterns
  if (excludePatterns && excludePatterns.length > 0) {
    const excluded = excludePatterns.some(pattern =>
      picomatch.isMatch(filePath, pattern, { dot: true })
    );
    if (excluded) return false;
  }

  return true;
}

function filterTree(
  tree: GitFile[],
  includePatterns?: string[],
  excludePatterns?: string[]
): GitFile[] {
  if (!includePatterns?.length && !excludePatterns?.length) {
    return tree;
  }

  return tree.filter(file =>
    matchesPatterns(file.path, includePatterns, excludePatterns)
  );
}

// Hierarchical tree formatter
function formatHierarchicalTree(tree: GitFile[]): string {
  // Build tree structure
  const root: Record<string, any> = {};

  for (const item of tree) {
    const parts = item.path.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue; // Skip empty parts
      if (i === parts.length - 1) {
        // Leaf node
        current[part] = {
          _isFile: item.type === "file",
          _size: item.size
        };
      } else {
        // Directory node
        if (!current[part]) current[part] = {};
        current = current[part];
      }
    }
  }

  // Render tree
  function renderNode(node: Record<string, any>, prefix: string = ""): string {
    let result = "";
    const entries = Object.entries(node).filter(([k]) => !k.startsWith("_"));
    const sorted = entries.sort(([a, va], [b, vb]) => {
      const aIsDir = !va._isFile;
      const bIsDir = !vb._isFile;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.localeCompare(b);
    });

    sorted.forEach(([name, value], index) => {
      const isLast = index === sorted.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (value._isFile) {
        const size = value._size ? ` (${value._size} bytes)` : "";
        result += `${prefix}${connector}${name}${size}\n`;
      } else {
        result += `${prefix}${connector}${name}/\n`;
        result += renderNode(value, prefix + childPrefix);
      }
    });

    return result;
  }

  return renderNode(root);
}

// Git pricing configuration - Per KB output model
const GIT_PRICING = {
  baseRequest: 0.0005,      // Base cost for any request
  perKB: 0.00005,           // $0.00005 per KB of output
  perFileListed: 0.000005,  // Cost per file in tree
  minPrice: 0.0001,         // Minimum price for paid tier
  freeTierMaxKB: 10,        // Free if output < 10KB
  freeTierMaxFiles: 10,     // Free if tree has <= 10 files and no content
};

interface GitPricingParams {
  repoSize?: number;        // In KB
  fileCount?: number;
  estimatedOutputKB?: number;
  includeContent?: boolean;
  includeTree?: boolean;
  includePatterns?: string[];  // Glob patterns to include
  excludePatterns?: string[];  // Glob patterns to exclude
  maxFileSize?: number;        // Max file size in bytes
}

function isGitFreeTier(params: GitPricingParams): boolean {
  if (params.includeContent) return false;
  if (params.includeTree && (params.fileCount || 0) > GIT_PRICING.freeTierMaxFiles) return false;
  return true;
}

function calculateGitPrice(params: GitPricingParams, basePrice: number): string {
  if (isGitFreeTier(params)) return "$0";

  // Estimate output size
  let estimatedKB = params.estimatedOutputKB || 0;
  if (!estimatedKB) {
    // Fallback estimation based on params
    estimatedKB = 5; // Base for metadata + README
    if (params.includeTree) {
      estimatedKB += (params.fileCount || 0) * 0.05; // ~50 bytes per file listing
    }
    if (params.includeContent) {
      // Estimate text content at 30% of repo size
      let contentEstimate = (params.repoSize || 0) * 0.3;

      // Apply reduction factors for filtering
      if (params.includePatterns && params.includePatterns.length > 0) {
        // Include patterns significantly reduce output - estimate 20% of original
        contentEstimate *= 0.2;
      }
      if (params.excludePatterns && params.excludePatterns.length > 0) {
        // Exclude patterns reduce output - estimate 70% of current
        contentEstimate *= 0.7;
      }
      if (params.maxFileSize && params.maxFileSize < 100000) {
        // Small maxFileSize limit reduces output
        // Default is 100KB, so if lower, apply proportional reduction
        const reduction = Math.max(0.1, params.maxFileSize / 100000);
        contentEstimate *= reduction;
      }

      estimatedKB += contentEstimate;
    }
  }

  let cost = GIT_PRICING.baseRequest + (estimatedKB * GIT_PRICING.perKB);
  cost = Math.max(cost, GIT_PRICING.minPrice, basePrice);

  const rounded = Math.round(cost * 1000000) / 1000000;
  return `$${rounded}`;
}

// Parse Git URL to extract owner, repo, and platform
function parseGitUrl(url: string): { platform: "github" | "gitlab" | "bitbucket"; owner: string; repo: string } | null {
  // GitHub: https://github.com/owner/repo or github.com/owner/repo
  const githubMatch = url.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/]+)\/([^\/\s#?]+)/i);
  if (githubMatch?.[1] && githubMatch[2]) {
    return { platform: "github", owner: githubMatch[1], repo: githubMatch[2].replace(/\.git$/, "") };
  }

  // GitLab: https://gitlab.com/owner/repo
  const gitlabMatch = url.match(/(?:https?:\/\/)?(?:www\.)?gitlab\.com\/([^\/]+)\/([^\/\s#?]+)/i);
  if (gitlabMatch?.[1] && gitlabMatch[2]) {
    return { platform: "gitlab", owner: gitlabMatch[1], repo: gitlabMatch[2].replace(/\.git$/, "") };
  }

  // Bitbucket: https://bitbucket.org/owner/repo
  const bitbucketMatch = url.match(/(?:https?:\/\/)?(?:www\.)?bitbucket\.org\/([^\/]+)\/([^\/\s#?]+)/i);
  if (bitbucketMatch?.[1] && bitbucketMatch[2]) {
    return { platform: "bitbucket", owner: bitbucketMatch[1], repo: bitbucketMatch[2].replace(/\.git$/, "") };
  }

  return null;
}

async function fetchGitHubRepo(owner: string, repo: string, params: GitQueryParams): Promise<GitResponse & { params?: GitQueryParams; meta?: GitResponseMeta }> {
  await rateLimiter.waitForSlot("github:repo");

  // Fetch repo metadata
  const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)",
    },
  });

  if (!repoResponse.ok) {
    if (repoResponse.status === 404) {
      throw new Error(`Repository not found: ${owner}/${repo}`);
    }
    throw new Error(`GitHub API error: ${repoResponse.status}`);
  }

  const repoData = await repoResponse.json() as any;
  const branch = params.branch || repoData.default_branch;

  const gitRepo: GitRepo = {
    name: repoData.name,
    fullName: repoData.full_name,
    description: repoData.description,
    url: repoData.html_url,
    defaultBranch: repoData.default_branch,
    language: repoData.language,
    stars: repoData.stargazers_count,
    forks: repoData.forks_count,
    size: repoData.size, // KB
    createdAt: repoData.created_at,
    updatedAt: repoData.updated_at,
    owner: {
      name: repoData.owner.login,
      url: repoData.owner.html_url,
      avatar: repoData.owner.avatar_url,
    },
    topics: repoData.topics,
    license: repoData.license?.name,
  };

  // Fetch README
  let readme: string | undefined;
  try {
    await rateLimiter.waitForSlot("github:readme");
    const readmeResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers: {
        "Accept": "application/vnd.github.v3.raw",
        "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)",
      },
    });
    if (readmeResponse.ok) {
      readme = await readmeResponse.text();
    }
  } catch (err) {
    console.error("Failed to fetch README:", err);
  }

  // Fetch tree if requested
  const files: GitFile[] = [];
  let tree: GitFile[] | undefined;
  let commitSha: string | undefined;
  let totalFileCount = 0;

  if (params.includeTree || params.includeContent) {
    try {
      await rateLimiter.waitForSlot("github:tree");
      const treeResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        {
          headers: {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)",
          },
        }
      );

      if (treeResponse.ok) {
        const treeData = await treeResponse.json() as any;
        commitSha = treeData.sha;

        const rawTree: GitFile[] = (treeData.tree || []).map((item: any) => ({
          path: item.path,
          name: item.path.split("/").pop() || item.path,
          type: item.type === "tree" ? "dir" : "file",
          size: item.size,
          sha: item.sha,
        }));

        totalFileCount = rawTree.filter(f => f.type === "file").length;

        // Apply include/exclude pattern filtering
        tree = filterTree(rawTree, params.includePatterns, params.excludePatterns);
      }
    } catch (err) {
      console.error("Failed to fetch tree:", err);
    }
  }

  // Fetch file contents if requested
  if (params.includeContent && tree) {
    const maxSize = params.maxFileSize || 100000; // 100KB default
    const textExtensions = [".md", ".txt", ".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".css", ".html", ".json", ".yaml", ".yml", ".toml", ".xml", ".sh", ".bash", ".zsh", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".astro"];

    // Filter tree is already applied, now filter for text files and size
    const filesToFetch = tree
      .filter((f) => f.type === "file" && (f.size || 0) <= maxSize)
      .filter((f) => textExtensions.some((ext) => f.path.toLowerCase().endsWith(ext)))
      .slice(0, 50); // Limit to 50 files

    for (const file of filesToFetch) {
      try {
        await rateLimiter.waitForSlot("github:content");
        const contentResponse = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${file.path}?ref=${branch}`,
          {
            headers: {
              "Accept": "application/vnd.github.v3.raw",
              "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)",
            },
          }
        );

        if (contentResponse.ok) {
          const content = await contentResponse.text();
          files.push({ ...file, content });
        }
      } catch (err) {
        console.error(`Failed to fetch ${file.path}:`, err);
      }
    }
  }

  // Build metadata
  const filteredFileCount = tree?.filter(f => f.type === "file").length || 0;
  const meta: GitResponseMeta = {
    commitSha: commitSha || "unknown",
    branch,
    outputBytes: 0, // Will be calculated after formatting
    estimatedTokens: 0,
    filteredFileCount,
    totalFileCount,
  };

  return { repo: gitRepo, files, readme, tree: params.includeTree ? tree : undefined, params, meta };
}

async function fetchGitLabRepo(owner: string, repo: string, params: GitQueryParams): Promise<GitResponse & { params?: GitQueryParams }> {
  const projectPath = encodeURIComponent(`${owner}/${repo}`);

  await rateLimiter.waitForSlot("gitlab:repo");

  const repoResponse = await fetch(`https://gitlab.com/api/v4/projects/${projectPath}`, {
    headers: {
      "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)",
    },
  });

  if (!repoResponse.ok) {
    if (repoResponse.status === 404) {
      throw new Error(`Repository not found: ${owner}/${repo}`);
    }
    throw new Error(`GitLab API error: ${repoResponse.status}`);
  }

  const repoData = await repoResponse.json() as any;

  const gitRepo: GitRepo = {
    name: repoData.name,
    fullName: repoData.path_with_namespace,
    description: repoData.description,
    url: repoData.web_url,
    defaultBranch: repoData.default_branch,
    language: undefined, // GitLab doesn't provide primary language in this endpoint
    stars: repoData.star_count,
    forks: repoData.forks_count,
    size: Math.round((repoData.statistics?.repository_size || 0) / 1024), // Convert to KB
    createdAt: repoData.created_at,
    updatedAt: repoData.last_activity_at,
    owner: {
      name: repoData.namespace.name,
      url: repoData.namespace.web_url,
      avatar: repoData.namespace.avatar_url,
    },
    topics: repoData.topics,
    license: undefined,
  };

  // Fetch README
  let readme: string | undefined;
  try {
    await rateLimiter.waitForSlot("gitlab:readme");
    const readmeResponse = await fetch(
      `https://gitlab.com/api/v4/projects/${projectPath}/repository/files/README.md/raw?ref=${repoData.default_branch}`,
      {
        headers: { "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)" },
      }
    );
    if (readmeResponse.ok) {
      readme = await readmeResponse.text();
    }
  } catch (err) {
    console.error("Failed to fetch README:", err);
  }

  // Fetch tree if requested
  let tree: GitFile[] | undefined;
  if (params.includeTree) {
    try {
      await rateLimiter.waitForSlot("gitlab:tree");
      const branch = params.branch || repoData.default_branch;
      const treeResponse = await fetch(
        `https://gitlab.com/api/v4/projects/${projectPath}/repository/tree?ref=${branch}&recursive=true&per_page=100`,
        {
          headers: { "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)" },
        }
      );

      if (treeResponse.ok) {
        const treeData = await treeResponse.json() as any[];
        tree = treeData.map((item: any) => ({
          path: item.path,
          name: item.name,
          type: item.type === "tree" ? "dir" : "file",
          sha: item.id,
        }));
      }
    } catch (err) {
      console.error("Failed to fetch tree:", err);
    }
  }

  return { repo: gitRepo, files: [], readme, tree, params };
}

async function fetchGitRepo(url: string, params: GitQueryParams): Promise<GitResponse & { params?: GitQueryParams }> {
  const parsed = parseGitUrl(url);
  if (!parsed) {
    throw new Error("Unsupported git URL. Supported: GitHub, GitLab, Bitbucket");
  }

  switch (parsed.platform) {
    case "github":
      return fetchGitHubRepo(parsed.owner, parsed.repo, params);
    case "gitlab":
      return fetchGitLabRepo(parsed.owner, parsed.repo, params);
    default:
      throw new Error(`Platform ${parsed.platform} not yet supported`);
  }
}

function formatGitTextOutput(data: GitResponse & { params?: GitQueryParams; meta?: GitResponseMeta }): string {
  const { repo, files, readme, tree, meta } = data;
  const separator = "═".repeat(60);
  const thinSeparator = "─".repeat(60);

  let out = `${separator}\n`;
  out += `Git Repository Export\n`;
  out += `${separator}\n\n`;

  // Repository info
  out += `Name: ${repo.fullName}\n`;
  if (repo.description) out += `Description: ${repo.description}\n`;
  out += `URL: ${repo.url}\n`;
  out += `Branch: ${meta?.branch || repo.defaultBranch}\n`;
  if (meta?.commitSha && meta.commitSha !== "unknown") out += `Commit: ${meta.commitSha}\n`;
  if (repo.language) out += `Language: ${repo.language}\n`;
  if (repo.stars !== undefined) out += `Stars: ${repo.stars.toLocaleString()}\n`;
  if (repo.forks !== undefined) out += `Forks: ${repo.forks.toLocaleString()}\n`;
  out += `Size: ${repo.size.toLocaleString()} KB\n`;
  if (repo.license) out += `License: ${repo.license}\n`;
  if (repo.topics?.length) out += `Topics: ${repo.topics.join(", ")}\n`;
  if (repo.createdAt) out += `Created: ${repo.createdAt}\n`;
  if (repo.updatedAt) out += `Updated: ${repo.updatedAt}\n`;

  out += `\n${separator}\n`;
  out += `Owner\n`;
  out += `${separator}\n\n`;
  out += `Name: ${repo.owner.name}\n`;
  out += `URL: ${repo.owner.url}\n`;

  if (readme) {
    out += `\n${separator}\n`;
    out += `README\n`;
    out += `${separator}\n\n`;
    out += `${readme}\n`;
  }

  if (tree && tree.length > 0) {
    const fileCount = tree.filter(f => f.type === "file").length;
    out += `\n${separator}\n`;
    out += `File Tree (${fileCount} files`;
    if (meta && meta.totalFileCount > meta.filteredFileCount) {
      out += `, filtered from ${meta.totalFileCount}`;
    }
    out += `)\n`;
    out += `${separator}\n\n`;
    out += formatHierarchicalTree(tree);
  }

  if (files.length > 0) {
    out += `\n${separator}\n`;
    out += `File Contents (${files.length} files)\n`;
    out += `${separator}\n`;
    files.forEach((file) => {
      out += `\n${thinSeparator}\n`;
      out += `FILE: ${file.path}\n`;
      if (file.size) out += `SIZE: ${file.size.toLocaleString()} bytes\n`;
      if (file.sha) out += `SHA: ${file.sha.slice(0, 8)}\n`;
      out += `${thinSeparator}\n\n`;
      out += `${file.content || "(content not available)"}\n`;
    });
  }

  // Calculate metadata and add footer
  const outputBytes = new TextEncoder().encode(out).length;
  const estimatedTokens = Math.ceil(out.length / 4); // ~4 chars per token

  out += `\n${separator}\n`;
  out += `Export Metadata\n`;
  out += `${separator}\n\n`;
  out += `Output Size: ${outputBytes.toLocaleString()} bytes\n`;
  out += `Estimated Tokens: ~${estimatedTokens.toLocaleString()}\n`;
  out += `Generated: ${new Date().toISOString()}\n`;

  return out;
}

// Git estimate endpoint
app.get("/git/estimate", async (c) => {
  try {
    const url = c.req.query("url");
    if (!url) {
      return c.json({ error: "url required" }, 400);
    }

    // Parse filter patterns
    const includeParam = c.req.query("include");
    const excludeParam = c.req.query("exclude");
    const maxFileSizeParam = c.req.query("maxFileSize");

    const params: GitPricingParams = {
      includeContent: c.req.query("includeContent") === "true",
      includeTree: c.req.query("includeTree") === "true",
      includePatterns: includeParam ? includeParam.split(",").map(p => p.trim()).filter(Boolean) : undefined,
      excludePatterns: excludeParam ? excludeParam.split(",").map(p => p.trim()).filter(Boolean) : undefined,
      maxFileSize: maxFileSizeParam ? Number(maxFileSizeParam) : undefined,
    };

    if (isGitFreeTier(params)) {
      return c.json({ price: "$0", isFree: true, repoSize: null, fileCount: null });
    }

    // Fetch repo info for accurate pricing
    let repoSize: number | undefined = undefined;
    let fileCount: number | undefined = undefined;

    const parsed = parseGitUrl(url);
    if (parsed?.platform === "github") {
      try {
        const repoResponse = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
          headers: {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)",
          },
        });
        if (repoResponse.ok) {
          const repoData = await repoResponse.json() as any;
          repoSize = repoData.size;
          params.repoSize = repoSize;

          // Get file count from tree
          if (params.includeTree) {
            const treeResponse = await fetch(
              `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${repoData.default_branch}?recursive=1`,
              {
                headers: {
                  "Accept": "application/vnd.github.v3+json",
                  "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)",
                },
              }
            );
            if (treeResponse.ok) {
              const treeData = await treeResponse.json() as any;
              fileCount = treeData.tree?.length || 0;
              params.fileCount = fileCount;
            }
          }
        }
      } catch (err) {
        console.error("Failed to fetch repo info for estimate:", err);
      }
    }

    const price = calculateGitPrice(params, parseDollarPrice(c.env.X402_BASE_PRICE || "$0.001"));
    return c.json({ price, isFree: false, repoSize, fileCount });
  } catch (error) {
    console.error("Git estimate error:", error);
    return c.json({ error: "Failed to calculate estimate" }, 500);
  }
});

// Git payment middleware
app.use("/git", async (c, next) => {
  const query = c.req.query();
  if (!Object.keys(query).length || !query.url) {
    return next();
  }

  const payTo = c.env.X402_PAY_TO;
  const network = (c.env.X402_NETWORK || "eip155:84532") as Network;
  const facilitatorUrl = c.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
  const basePrice = c.env.X402_BASE_PRICE || "$0.001";

  if (!payTo) return next();

  const pricingParams: GitPricingParams = {
    includeContent: String(query.includeContent).toLowerCase() === "true",
    includeTree: String(query.includeTree).toLowerCase() === "true",
    includePatterns: query.include ? String(query.include).split(",").map(p => p.trim()).filter(Boolean) : undefined,
    excludePatterns: query.exclude ? String(query.exclude).split(",").map(p => p.trim()).filter(Boolean) : undefined,
    maxFileSize: query.maxFileSize ? Number(query.maxFileSize) : undefined,
  };

  if (isGitFreeTier(pricingParams)) {
    return next();
  }

  // Fetch repo info for pricing
  const parsed = parseGitUrl(query.url);
  if (parsed?.platform === "github") {
    try {
      const repoResponse = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "LLM-Git-Bot/1.0 (+https://llm-git.fun)",
        },
      });
      if (repoResponse.ok) {
        const repoData = await repoResponse.json() as any;
        pricingParams.repoSize = repoData.size;
      }
    } catch (err) {
      console.error("Failed to fetch repo for pricing:", err);
    }
  }

  const dynamicPrice = calculateGitPrice(pricingParams, parseDollarPrice(basePrice));
  const server = getX402Server({
    url: facilitatorUrl,
    cdpApiKeyId: c.env.CDP_API_KEY_ID,
    cdpApiKeySecret: c.env.CDP_API_KEY_SECRET,
  });

  const middleware = paymentMiddleware(
    {
      "GET /git": {
        accepts: [{ scheme: "exact", price: dynamicPrice, network, payTo }],
        description: `Git repo export - ${dynamicPrice}`,
        mimeType: "text/plain",
        extensions: {
          ...declareDiscoveryExtension({
            input: { url: "https://github.com/coinbase/x402", includeTree: true },
            inputSchema: {
              properties: {
                url: { type: "string", description: "Git repository URL (GitHub, GitLab, or Bitbucket)" },
                branch: { type: "string", description: "Branch to fetch (default: default branch)" },
                includeTree: { type: "boolean", description: "Include file tree listing" },
                includeContent: { type: "boolean", description: "Include file contents for text files" },
                maxFileSize: { type: "number", description: "Max file size in bytes to include content (default: 100000)" },
                include: { type: "string", description: "Comma-separated glob patterns to include (e.g., 'src/**/*.ts,*.md')" },
                exclude: { type: "string", description: "Comma-separated glob patterns to exclude (e.g., 'node_modules/**,*.lock')" },
              },
              required: ["url"],
            },
            output: {
              example: "════════════════════════════════════════════════════════════\nGit Repository Export\n════════════════════════════════════════════════════════════\n\nName: coinbase/x402\nDescription: x402 payment protocol\nURL: https://github.com/coinbase/x402\nBranch: main\nStars: 1,234\n\n════════════════════════════════════════════════════════════\nREADME\n════════════════════════════════════════════════════════════\n\n# x402\n\nPayment protocol for the web...",
              schema: {
                type: "string",
                description: "Plain text formatted Git repository export with metadata, README, file tree, and optionally file contents",
              },
            },
          }),
        },
      },
    },
    server
  );

  return middleware(c, next);
});

// Git main endpoint
app.get("/git", async (c) => {
  try {
    const url = c.req.query("url");
    if (!url) {
      if (!Object.keys(c.req.query()).length) return c.redirect("https://llm-git.fun");
      return c.text("url required", 400);
    }

    // Parse comma-separated include/exclude patterns
    const includeParam = c.req.query("include");
    const excludeParam = c.req.query("exclude");

    const includePatterns = includeParam
      ?.split(",")
      .map(p => p.trim())
      .filter(Boolean);

    const excludePatterns = excludeParam
      ?.split(",")
      .map(p => p.trim())
      .filter(Boolean);

    const q: GitQueryParams = {
      url,
      branch: c.req.query("branch"),
      includeContent: String(c.req.query("includeContent")).toLowerCase() === "true",
      includeTree: String(c.req.query("includeTree")).toLowerCase() === "true",
      maxFileSize: c.req.query("maxFileSize") ? Number(c.req.query("maxFileSize")) : undefined,
      includePatterns: includePatterns?.length ? includePatterns : undefined,
      excludePatterns: excludePatterns?.length ? excludePatterns : undefined,
    };

    const data = await fetchGitRepo(url, q);

    c.header("Content-Type", "text/plain");
    return c.text(formatGitTextOutput(data));
  } catch (err) {
    console.error(err);
    return c.text(`Error: ${err instanceof Error ? err.message : "Unknown"}`, 500);
  }
});

export default app;
