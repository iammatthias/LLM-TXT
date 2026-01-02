import { useState, useEffect, useMemo } from "react";
import type { GitQueryParams } from "shared";
import { LlmGitClient, type GitFetchOptions } from "@llm-txt/sdk";
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
  title: "LLM-GIT.TXT",
  subtitle: "Git Repository Export Utility",
  idleText: "Enter Git repository URL...",
  loadingText: "Cloning repository...",
  footerLinks: [
    { label: "llm-txt.fun", href: "https://llm-txt.fun" },
    { label: "GITHUB", href: "https://github.com" },
    { label: "X402", href: "https://x402.org/" },
  ],
};

function App() {
  const terminal = useTerminalState();
  const { pricing, loading: pricingLoading } = usePricing(SERVER_URL);

  const [params, setParams] = useState<GitQueryParams>({
    url: "",
    branch: "",
    includeTree: true,
    includeContent: false,
    maxFileSize: 100000,
    includePatterns: undefined,
    excludePatterns: undefined,
  });

  const [includeInput, setIncludeInput] = useState("");
  const [excludeInput, setExcludeInput] = useState("");
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  const [serverEstimate, setServerEstimate] = useState<{
    price: string;
    isFree: boolean;
    repoSize: number | null;
    fileCount: number | null;
  } | null>(null);
  const [loadingEstimate, setLoadingEstimate] = useState(false);

  const sdkClient = useMemo(() => {
    return new LlmGitClient({ baseUrl: SERVER_URL, signer: terminal.wallet.signer });
  }, [terminal.wallet.signer]);

  // Fetch estimate
  useEffect(() => {
    if (!terminal.debouncedInput.trim()) {
      setServerEstimate(null);
      return;
    }
    let cancelled = false;
    setLoadingEstimate(true);
    const options: GitFetchOptions = { ...params, url: terminal.debouncedInput.trim() };
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
      if (params.branch) queryParams.set("branch", params.branch);
      if (params.includeTree) queryParams.set("includeTree", "true");
      if (params.includeContent) queryParams.set("includeContent", "true");
      if (params.maxFileSize) queryParams.set("maxFileSize", params.maxFileSize.toString());
      if (params.includePatterns?.length) queryParams.set("include", params.includePatterns.join(","));
      if (params.excludePatterns?.length) queryParams.set("exclude", params.excludePatterns.join(","));
      setGeneratedUrl(`${SERVER_URL}/git?${queryParams.toString()}`);
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
      const options: GitFetchOptions = { ...params, url: terminal.input.trim() };
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
      const repoUrl = new URL(terminal.input);
      const pathParts = repoUrl.pathname.split("/").filter(Boolean);
      const repoName = pathParts.length >= 2 ? `${pathParts[0]}-${pathParts[1]}` : pathParts[0] || "repo";
      a.download = `${repoName}.txt`;
    } catch {
      a.download = "repo.txt";
    }
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const formatSize = (kb: number) => (kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toLocaleString()} KB`);

  const stats = [];
  if (terminal.debouncedInput && serverEstimate?.repoSize != null) {
    stats.push({ label: "REPO SIZE", value: serverEstimate.repoSize, formatter: formatSize });
  }
  if (terminal.debouncedInput && serverEstimate?.fileCount != null) {
    stats.push({ label: "FILES", value: serverEstimate.fileCount });
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
          <TerminalRow label='REPO URL'>
            <TerminalInput
              type='text'
              value={terminal.input}
              onChange={(e) => terminal.setInput(e.target.value)}
              placeholder='https://github.com/owner/repo'
              disabled={terminal.isLoading}
            />
          </TerminalRow>

          <TerminalRow label='BRANCH'>
            <TerminalInput
              type='text'
              value={params.branch || ""}
              onChange={(e) => setParams({ ...params, branch: e.target.value || undefined })}
              placeholder='default'
              disabled={terminal.isLoading}
              small
            />
          </TerminalRow>

          <TerminalRow label='INCLUDE'>
            <TerminalInput
              type='text'
              value={includeInput}
              onChange={(e) => {
                setIncludeInput(e.target.value);
                const patterns = e.target.value
                  .split(",")
                  .map((p) => p.trim())
                  .filter(Boolean);
                setParams({ ...params, includePatterns: patterns.length ? patterns : undefined });
              }}
              placeholder='src/**/*.ts, *.md'
              disabled={terminal.isLoading}
            />
          </TerminalRow>

          <TerminalRow label='EXCLUDE'>
            <TerminalInput
              type='text'
              value={excludeInput}
              onChange={(e) => {
                setExcludeInput(e.target.value);
                const patterns = e.target.value
                  .split(",")
                  .map((p) => p.trim())
                  .filter(Boolean);
                setParams({ ...params, excludePatterns: patterns.length ? patterns : undefined });
              }}
              placeholder='node_modules/**, *.lock'
              disabled={terminal.isLoading}
            />
          </TerminalRow>

          <TerminalRow label='MAX FILE'>
            <TerminalSelect
              value={params.maxFileSize || 100000}
              onChange={(e) => setParams({ ...params, maxFileSize: Number(e.target.value) })}
              small
            >
              <option value={50000}>50 KB</option>
              <option value={100000}>100 KB</option>
              <option value={250000}>250 KB</option>
              <option value={500000}>500 KB</option>
              <option value={1000000}>1 MB</option>
            </TerminalSelect>
          </TerminalRow>

          <TerminalRow label='OPTIONS'>
            <TerminalOptions>
              <TerminalOption
                label='FILE TREE'
                checked={params.includeTree ?? false}
                onChange={(checked) => setParams({ ...params, includeTree: checked })}
              />
              <TerminalOption
                label='FILE CONTENT'
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

          <PricingTable pricing={pricing?.git} loading={pricingLoading} />
        </TerminalForm>
      }
    />
  );
}

export default App;
