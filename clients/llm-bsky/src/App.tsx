import { useState, useEffect, useMemo } from "react";
import type { BlueskyQueryParams } from "shared";
import { LlmBskyClient, type BskyFetchOptions } from "@llm-txt/sdk";
import {
  TerminalLayout,
  TerminalForm,
  TerminalRow,
  TerminalInput,
  TerminalSelect,
  TerminalOptions,
  TerminalOption,
  TerminalButton,
  PricingTable,
  useTerminalState,
  usePricing,
  type TerminalLayoutConfig,
} from "../../shared";
import "./App.css";

const SERVER_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "https://api.llm-txt.fun" : "/api");

const config: TerminalLayoutConfig = {
  title: "LLM-BSKY.TXT",
  subtitle: "Bluesky Profile Export Utility",
  idleText: "Enter handle or DID...",
  loadingText: "Fetching posts...",
  footerLinks: [
    { label: "llm-txt.fun", href: "https://llm-txt.fun" },
    { label: "BLUESKY", href: "https://bsky.app/" },
    { label: "X402", href: "https://x402.org/" },
  ],
};

function App() {
  const terminal = useTerminalState();
  const { pricing, loading: pricingLoading } = usePricing(SERVER_URL);

  const [params, setParams] = useState<BlueskyQueryParams>({
    limit: 10,
    includeReplies: false,
    all: false,
    sortOrder: "newest",
    includeReactions: false,
    includeParents: false,
  });

  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  const [serverEstimate, setServerEstimate] = useState<{
    price: string;
    isFree: boolean;
    postCount: number | null;
  } | null>(null);
  const [loadingEstimate, setLoadingEstimate] = useState(false);

  const sdkClient = useMemo(() => {
    return new LlmBskyClient({ baseUrl: SERVER_URL, signer: terminal.wallet.signer });
  }, [terminal.wallet.signer]);

  // Fetch estimate
  useEffect(() => {
    if (!terminal.debouncedInput.trim()) {
      setServerEstimate(null);
      return;
    }
    let cancelled = false;
    setLoadingEstimate(true);
    const isDid = terminal.debouncedInput.startsWith("did:");
    const options: BskyFetchOptions = {
      ...params,
      ...(isDid
        ? { did: terminal.debouncedInput }
        : { handle: terminal.debouncedInput.trim().replace(/^@/, "").toLowerCase() }),
    };
    sdkClient.getServerEstimate(options).then((estimate) => {
      if (!cancelled) {
        setServerEstimate(estimate);
        setLoadingEstimate(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [terminal.debouncedInput, params, sdkClient]);

  // Generate URL
  useEffect(() => {
    if (!terminal.debouncedInput.trim()) {
      setGeneratedUrl(null);
      return;
    }
    try {
      const isDid = terminal.debouncedInput.startsWith("did:");
      const queryParams = new URLSearchParams();
      if (isDid) {
        queryParams.set("did", terminal.debouncedInput);
      } else {
        queryParams.set("handle", terminal.debouncedInput.trim().replace(/^@/, "").toLowerCase());
      }
      if (params.limit && !params.all) queryParams.set("limit", params.limit.toString());
      if (params.all) queryParams.set("all", "true");
      if (params.includeReplies) queryParams.set("includeReplies", "true");
      if (params.includeParents) queryParams.set("includeParents", "true");
      if (params.sortOrder && params.sortOrder !== "newest") queryParams.set("sortOrder", params.sortOrder);
      if (params.includeReactions) queryParams.set("includeReactions", "true");
      setGeneratedUrl(`${SERVER_URL}/bsky?${queryParams.toString()}`);
    } catch {
      setGeneratedUrl(null);
    }
  }, [terminal.debouncedInput, params]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!generatedUrl) return;

    terminal.setIsLoading(true);
    terminal.setError(null);
    terminal.setFetchedData(null);
    terminal.setPaymentRequired(false);
    terminal.setPaymentInfo(null);

    try {
      const isDid = terminal.input.startsWith("did:");
      const options: BskyFetchOptions = {
        ...params,
        ...(isDid ? { did: terminal.input } : { handle: terminal.input.trim().replace(/^@/, "").toLowerCase() }),
      };
      const result = await sdkClient.fetch(options);

      if (result.status === 402) {
        terminal.setPaymentRequired(true);
        terminal.setError("Payment required. Connect wallet to proceed.");
        return;
      }

      if (result.status !== 200) {
        throw new Error(`Request failed: ${result.status}`);
      }

      terminal.setFetchedData(result.text);

      if (!serverEstimate?.isFree && terminal.wallet.signer) {
        terminal.setPaymentInfo({ amount: serverEstimate?.price || "paid", network: "Base" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (message.toLowerCase().includes("payment") || message.toLowerCase().includes("sign")) {
        terminal.setPaymentRequired(true);
        terminal.setError(`Payment error: ${message}`);
      } else {
        terminal.setError(message);
      }
    } finally {
      terminal.setIsLoading(false);
    }
  };

  const handleDownload = () => {
    if (!terminal.fetchedData) return;
    const blob = new Blob([terminal.fetchedData], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const filename = terminal.input.startsWith("did:")
      ? `bsky-${terminal.input.slice(0, 20)}.txt`
      : `${terminal.input.replace(/^@/, "")}.txt`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const stats = [];
  if (terminal.debouncedInput && serverEstimate?.postCount != null) {
    stats.push({ label: "POSTS", value: serverEstimate.postCount });
  }

  return (
    <TerminalLayout
      config={config}
      state={{
        isLoading: terminal.isLoading,
        error: terminal.error,
        fetchedData: terminal.fetchedData,
        paymentRequired: terminal.paymentRequired,
        paymentInfo: terminal.paymentInfo,
        copied: terminal.copied,
      }}
      wallet={{
        isConnected: terminal.wallet.isConnected,
        address: terminal.wallet.address,
        isConnecting: terminal.wallet.isConnecting,
        onConnect: terminal.wallet.connect,
        onDisconnect: terminal.wallet.disconnect,
      }}
      estimate={{
        loading: loadingEstimate,
        isFree: serverEstimate?.isFree,
        price: serverEstimate?.price,
        hasInput: !!terminal.debouncedInput,
      }}
      stats={stats}
      actions={{
        onCopy: terminal.handleCopy,
        onOpenInTab: terminal.handleOpenInTab,
        onDownload: handleDownload,
      }}
      queryForm={
        <TerminalForm onSubmit={handleSubmit}>
          <TerminalRow label='HANDLE'>
            <TerminalInput
              type='text'
              value={terminal.input}
              onChange={(e) => terminal.setInput(e.target.value)}
              placeholder='user.bsky.social or did:plc:...'
              disabled={terminal.isLoading}
            />
          </TerminalRow>

          <TerminalRow label='LIMIT'>
            <TerminalInput
              type='number'
              value={params.limit || ""}
              onChange={(e) => setParams({ ...params, limit: e.target.value ? Number(e.target.value) : 10 })}
              min={1}
              disabled={params.all}
              small
            />
          </TerminalRow>

          <TerminalRow label='SORT'>
            <TerminalSelect
              value={params.sortOrder}
              onChange={(e) => setParams({ ...params, sortOrder: e.target.value as "newest" | "oldest" })}
              small
            >
              <option value='newest'>NEWEST</option>
              <option value='oldest'>OLDEST</option>
            </TerminalSelect>
          </TerminalRow>

          <TerminalRow label='OPTIONS'>
            <TerminalOptions>
              <TerminalOption
                label='ALL'
                checked={params.all ?? false}
                onChange={(checked) =>
                  setParams({
                    ...params,
                    all: checked,
                    limit: checked ? undefined : 10,
                    includeReplies: checked ? false : params.includeReplies,
                    includeReactions: checked ? false : params.includeReactions,
                    includeParents: checked ? false : params.includeParents,
                  })
                }
              />
              <TerminalOption
                label='REPLIES'
                checked={params.includeReplies ?? false}
                onChange={(checked) => setParams({ ...params, includeReplies: checked })}
                disabled={params.all}
              />
              <TerminalOption
                label='REACTIONS'
                checked={params.includeReactions ?? false}
                onChange={(checked) => setParams({ ...params, includeReactions: checked })}
                disabled={params.all}
              />
              <TerminalOption
                label='PARENTS'
                checked={params.includeParents ?? false}
                onChange={(checked) => setParams({ ...params, includeParents: checked })}
                disabled={params.all || !params.includeReplies}
              />
            </TerminalOptions>
          </TerminalRow>

          <TerminalRow label=''>
            <TerminalButton type='submit' disabled={terminal.isLoading || !generatedUrl}>
              {terminal.isLoading ? "PROCESSING..." : "EXECUTE"}
            </TerminalButton>
          </TerminalRow>

          <PricingTable pricing={pricing?.bluesky} loading={pricingLoading} />
        </TerminalForm>
      }
    />
  );
}

export default App;
