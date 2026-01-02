/**
 * Shared Terminal State Hook
 * Common state management for all LLM-TXT frontends
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useAccount, useConnect, useDisconnect, useWalletClient } from "wagmi";
import { injected } from "wagmi/connectors";
import type { EvmSigner } from "@llm-txt/sdk";

export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

export interface TerminalStateReturn {
  // Core state
  input: string;
  setInput: (value: string) => void;
  debouncedInput: string;
  isLoading: boolean;
  setIsLoading: (value: boolean) => void;
  error: string | null;
  setError: (value: string | null) => void;
  fetchedData: string | null;
  setFetchedData: (value: string | null) => void;

  // Payment state
  paymentRequired: boolean;
  setPaymentRequired: (value: boolean) => void;
  paymentInfo: { amount: string; network: string } | null;
  setPaymentInfo: (value: { amount: string; network: string } | null) => void;

  // UI state
  copied: boolean;
  setCopied: (value: boolean) => void;

  // Wallet
  wallet: {
    address: string | undefined;
    isConnected: boolean;
    isConnecting: boolean;
    connect: () => void;
    disconnect: () => void;
    signer: EvmSigner | undefined;
  };

  // Actions
  handleCopy: () => Promise<void>;
  handleOpenInTab: () => void;
  resetState: () => void;
}

export function useTerminalState(debounceDelay = 500): TerminalStateReturn {
  // Core state
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedData, setFetchedData] = useState<string | null>(null);

  // Payment state
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [paymentInfo, setPaymentInfo] = useState<{ amount: string; network: string } | null>(null);

  // UI state
  const [copied, setCopied] = useState(false);

  // Wallet
  const { address, isConnected } = useAccount();
  const { connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();

  const debouncedInput = useDebounce(input, debounceDelay);

  const signer: EvmSigner | undefined = useMemo(() => {
    if (!walletClient?.account) return undefined;
    return {
      address: walletClient.account.address,
      signTypedData: (args: Parameters<EvmSigner["signTypedData"]>[0]) =>
        walletClient.signTypedData(args as Parameters<typeof walletClient.signTypedData>[0]),
    };
  }, [walletClient]);

  const handleConnect = useCallback(() => {
    connect({ connector: injected() });
  }, [connect]);

  const handleCopy = useCallback(async () => {
    if (!fetchedData) return;
    await navigator.clipboard.writeText(fetchedData);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [fetchedData]);

  const handleOpenInTab = useCallback(() => {
    if (!fetchedData) return;
    const blob = new Blob([fetchedData], { type: "text/plain" });
    window.open(URL.createObjectURL(blob), "_blank");
  }, [fetchedData]);

  const resetState = useCallback(() => {
    setIsLoading(false);
    setError(null);
    setFetchedData(null);
    setPaymentRequired(false);
    setPaymentInfo(null);
  }, []);

  return {
    input,
    setInput,
    debouncedInput,
    isLoading,
    setIsLoading,
    error,
    setError,
    fetchedData,
    setFetchedData,
    paymentRequired,
    setPaymentRequired,
    paymentInfo,
    setPaymentInfo,
    copied,
    setCopied,
    wallet: {
      address,
      isConnected,
      isConnecting,
      connect: handleConnect,
      disconnect,
      signer,
    },
    handleCopy,
    handleOpenInTab,
    resetState,
  };
}
