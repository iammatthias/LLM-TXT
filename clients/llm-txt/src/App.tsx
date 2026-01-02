import {
  Terminal,
  GenerativePattern,
  TerminalHeader,
  TerminalSection,
  TerminalFooter,
} from "../../shared";
import "./App.css";

const API_BASE = "https://api.llm-txt.fun";

const platforms = [
  {
    name: "LLM-FID",
    description: "Farcaster profile & cast exports",
    href: "https://llm-fid.fun",
    endpoint: "/fid",
  },
  {
    name: "LLM-BSKY",
    description: "Bluesky profile & post exports",
    href: "https://llm-bsky.fun",
    endpoint: "/bsky",
  },
  {
    name: "LLM-RSS",
    description: "RSS/Atom feed exports",
    href: "https://llm-rss.fun",
    endpoint: "/rss",
  },
  {
    name: "LLM-GIT",
    description: "Git repository exports",
    href: "https://llm-git.fun",
    endpoint: "/git",
  },
];

const footerLinks = [
  { label: "GitHub", href: "https://github.com/iammatthias/llm-txt" },
  { label: "x402", href: "https://x402.org" },
  { label: "npm", href: "https://npmjs.com/package/@llm-txt/sdk" },
];

function App() {
  return (
    <Terminal>
      <GenerativePattern />
      <TerminalHeader title="LLM-TXT" subtitle="Data Export for LLMs" />

      <TerminalSection title="PLATFORMS">
        <div className="platforms">
          {platforms.map((p) => (
            <a key={p.name} href={p.href} className="platform-card">
              <h3>{p.name}</h3>
              <p>{p.description}</p>
              <code>{p.endpoint}</code>
            </a>
          ))}
        </div>
      </TerminalSection>

      <TerminalSection title="API REFERENCE">
        <p className="section-intro">
          All endpoints return plain text optimized for LLM consumption. Paid requests use{" "}
          <a href="https://x402.org" target="_blank" rel="noopener">x402</a> micropayments on Base.
        </p>

        <div className="endpoint">
          <div className="endpoint-header">
            <span className="method">GET</span>
            <code>/fid</code>
          </div>
          <p>Export Farcaster user profile and casts</p>
          <table className="params-table">
            <thead>
              <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
            </thead>
            <tbody>
              <tr><td><code>fid</code></td><td>number</td><td>Farcaster ID</td></tr>
              <tr><td><code>username</code></td><td>string</td><td>Farcaster username (alternative to fid)</td></tr>
              <tr><td><code>limit</code></td><td>number</td><td>Max casts to return (default: 50)</td></tr>
              <tr><td><code>all</code></td><td>boolean</td><td>Fetch all casts</td></tr>
              <tr><td><code>includeReplies</code></td><td>boolean</td><td>Include reply casts</td></tr>
              <tr><td><code>includeParents</code></td><td>boolean</td><td>Include parent context for replies</td></tr>
              <tr><td><code>includeReactions</code></td><td>boolean</td><td>Include reaction counts</td></tr>
              <tr><td><code>sortOrder</code></td><td>string</td><td>"newest" or "oldest"</td></tr>
            </tbody>
          </table>
          <div className="example">
            <span>Example:</span>
            <code>{API_BASE}/fid?username=dwr.eth&limit=100</code>
          </div>
        </div>

        <div className="endpoint">
          <div className="endpoint-header">
            <span className="method">GET</span>
            <code>/bsky</code>
          </div>
          <p>Export Bluesky user profile and posts</p>
          <table className="params-table">
            <thead>
              <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
            </thead>
            <tbody>
              <tr><td><code>handle</code></td><td>string</td><td>Bluesky handle (e.g., user.bsky.social)</td></tr>
              <tr><td><code>did</code></td><td>string</td><td>Bluesky DID (alternative to handle)</td></tr>
              <tr><td><code>limit</code></td><td>number</td><td>Max posts to return (default: 50)</td></tr>
              <tr><td><code>all</code></td><td>boolean</td><td>Fetch all posts</td></tr>
              <tr><td><code>includeReplies</code></td><td>boolean</td><td>Include reply posts</td></tr>
              <tr><td><code>includeParents</code></td><td>boolean</td><td>Include parent context</td></tr>
              <tr><td><code>includeReactions</code></td><td>boolean</td><td>Include reaction counts</td></tr>
              <tr><td><code>sortOrder</code></td><td>string</td><td>"newest" or "oldest"</td></tr>
            </tbody>
          </table>
          <div className="example">
            <span>Example:</span>
            <code>{API_BASE}/bsky?handle=jay.bsky.team&limit=50</code>
          </div>
        </div>

        <div className="endpoint">
          <div className="endpoint-header">
            <span className="method">GET</span>
            <code>/rss</code>
          </div>
          <p>Export RSS or Atom feed content</p>
          <table className="params-table">
            <thead>
              <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
            </thead>
            <tbody>
              <tr><td><code>url</code></td><td>string</td><td>Feed URL (required)</td></tr>
              <tr><td><code>limit</code></td><td>number</td><td>Max items to return (default: 10)</td></tr>
              <tr><td><code>all</code></td><td>boolean</td><td>Fetch all items</td></tr>
              <tr><td><code>includeContent</code></td><td>boolean</td><td>Include full article content</td></tr>
              <tr><td><code>sortOrder</code></td><td>string</td><td>"newest" or "oldest"</td></tr>
            </tbody>
          </table>
          <div className="example">
            <span>Example:</span>
            <code>{API_BASE}/rss?url=https://blog.example.com/feed.xml&limit=20</code>
          </div>
        </div>

        <div className="endpoint">
          <div className="endpoint-header">
            <span className="method">GET</span>
            <code>/git</code>
          </div>
          <p>Export Git repository metadata, tree, and file contents</p>
          <table className="params-table">
            <thead>
              <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
            </thead>
            <tbody>
              <tr><td><code>url</code></td><td>string</td><td>Repository URL (required)</td></tr>
              <tr><td><code>branch</code></td><td>string</td><td>Branch name (default: default branch)</td></tr>
              <tr><td><code>includeTree</code></td><td>boolean</td><td>Include file tree listing</td></tr>
              <tr><td><code>includeContent</code></td><td>boolean</td><td>Include file contents</td></tr>
              <tr><td><code>include</code></td><td>string</td><td>Glob patterns to include (comma-separated)</td></tr>
              <tr><td><code>exclude</code></td><td>string</td><td>Glob patterns to exclude (comma-separated)</td></tr>
              <tr><td><code>maxFileSize</code></td><td>number</td><td>Max file size in bytes (default: 100000)</td></tr>
            </tbody>
          </table>
          <div className="example">
            <span>Example:</span>
            <code>{API_BASE}/git?url=https://github.com/owner/repo&includeContent=true</code>
          </div>
        </div>

        <div className="endpoint">
          <div className="endpoint-header">
            <span className="method">GET</span>
            <code>/pricing</code>
          </div>
          <p>Get current pricing configuration for all endpoints</p>
          <div className="example">
            <span>Example:</span>
            <code>{API_BASE}/pricing</code>
          </div>
        </div>
      </TerminalSection>

      <TerminalSection title="SDK">
        <p className="section-intro">
          TypeScript SDK with built-in x402 payment handling. Install from npm:
        </p>
        <pre className="code-block">npm install @llm-txt/sdk</pre>

        <h3 className="docs-subheader">Quick Start</h3>
        <pre className="code-block">{`import { LlmFidClient } from "@llm-txt/sdk";

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
});`}</pre>

        <h3 className="docs-subheader">Available Clients</h3>
        <table className="params-table">
          <thead>
            <tr><th>Client</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td><code>LlmFidClient</code></td><td>Farcaster data exports</td></tr>
            <tr><td><code>LlmBskyClient</code></td><td>Bluesky data exports</td></tr>
            <tr><td><code>LlmRssClient</code></td><td>RSS/Atom feed exports</td></tr>
            <tr><td><code>LlmGitClient</code></td><td>Git repository exports</td></tr>
          </tbody>
        </table>
      </TerminalSection>

      <TerminalSection title="X402 PAYMENTS">
        <p className="section-intro">
          Requests exceeding free tier limits require payment via{" "}
          <a href="https://x402.org" target="_blank" rel="noopener">x402</a>.
          Payments are made in USDC on Base.
        </p>
        <ul className="features-list">
          <li>Free tier available for small requests</li>
          <li>Pay-per-request micropayments</li>
          <li>Automatic payment handling with SDK</li>
          <li>Pricing scales with data volume</li>
        </ul>
      </TerminalSection>

      <TerminalFooter links={footerLinks} />
    </Terminal>
  );
}

export default App;
