import { useState, useEffect, useMemo } from "react";
import type { RssQueryParams } from "shared";
import { LlmRssClient, type RssFetchOptions } from "@llm-txt/sdk";
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
  title: "LLM-RSS.TXT",
  subtitle: "RSS/Atom Feed Export Utility",
  idleText: "Enter RSS/Atom feed URL...",
  loadingText: "Fetching feed...",
  footerLinks: [
    { label: "llm-txt.fun", href: "https://llm-txt.fun" },
    { label: "RSS SPEC", href: "https://www.rssboard.org/rss-specification" },
    { label: "X402", href: "https://x402.org/" },
  ],
};

function App() {
  const terminal = useTerminalState();
  const { pricing, loading: pricingLoading } = usePricing(SERVER_URL);

  const [params, setParams] = useState<RssQueryParams>({
    url: "",
    limit: 10,
    all: false,
    sortOrder: "newest",
    includeContent: false,
  });

  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  const [serverEstimate, setServerEstimate] = useState<{
    price: string;
    isFree: boolean;
    itemCount: number | null;
  } | null>(null);
  const [loadingEstimate, setLoadingEstimate] = useState(false);

  const sdkClient = useMemo(() => {
    return new LlmRssClient({ baseUrl: SERVER_URL, signer: terminal.wallet.signer });
  }, [terminal.wallet.signer]);

  // Fetch estimate
  useEffect(() => {
    if (!terminal.debouncedInput.trim()) {
      setServerEstimate(null);
      return;
    }
    let cancelled = false;
    setLoadingEstimate(true);
    const options: RssFetchOptions = { ...params, url: terminal.debouncedInput.trim() };
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
      const queryParams = new URLSearchParams();
      queryParams.set("url", terminal.debouncedInput.trim());
      if (params.limit && !params.all) queryParams.set("limit", params.limit.toString());
      if (params.all) queryParams.set("all", "true");
      if (params.includeContent) queryParams.set("includeContent", "true");
      if (params.sortOrder && params.sortOrder !== "newest") queryParams.set("sortOrder", params.sortOrder);
      setGeneratedUrl(`${SERVER_URL}/rss?${queryParams.toString()}`);
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
      const options: RssFetchOptions = { ...params, url: terminal.input.trim() };
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
    try {
      const feedUrl = new URL(terminal.input);
      a.download = `${feedUrl.hostname.replace(/\./g, "-")}-feed.txt`;
    } catch {
      a.download = "feed.txt";
    }
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const stats = [];
  if (terminal.debouncedInput && serverEstimate?.itemCount != null) {
    stats.push({ label: "ITEMS", value: serverEstimate.itemCount });
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
          <TerminalRow label='FEED URL'>
            <TerminalInput
              type='text'
              value={terminal.input}
              onChange={(e) => terminal.setInput(e.target.value)}
              placeholder='https://example.com/feed.xml'
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
                label='ALL ITEMS'
                checked={params.all ?? false}
                onChange={(checked) =>
                  setParams({
                    ...params,
                    all: checked,
                    limit: checked ? undefined : 10,
                  })
                }
              />
              <TerminalOption
                label='FULL CONTENT'
                checked={params.includeContent ?? false}
                onChange={(checked) => setParams({ ...params, includeContent: checked })}
              />
            </TerminalOptions>
          </TerminalRow>

          <TerminalRow label=''>
            <TerminalButton type='submit' disabled={terminal.isLoading || !generatedUrl}>
              {terminal.isLoading ? "PROCESSING..." : "EXECUTE"}
            </TerminalButton>
          </TerminalRow>

          <PricingTable pricing={pricing?.rss} loading={pricingLoading} />
        </TerminalForm>
      }
    />
  );
}

export default App;
