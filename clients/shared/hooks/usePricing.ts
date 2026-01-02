import { useState, useEffect } from "react";

export interface PricingExample {
  description: string;
  cost: string;
}

export interface PricingModifier {
  feature: string;
  effect: string;
  description: string;
}

export interface ServicePricing {
  freeTier: { description: string; maxCasts?: number; maxPosts?: number; maxItems?: number };
  examples: PricingExample[];
  modifiers: PricingModifier[];
  note: string;
}

export interface PricingData {
  farcaster: ServicePricing;
  bluesky: ServicePricing;
  rss: ServicePricing;
  git: ServicePricing;
  basePrice: string;
  currency: string;
}

// Cache pricing data globally to avoid refetching
let cachedPricing: PricingData | null = null;
let cachePromise: Promise<PricingData> | null = null;

export function usePricing(serverUrl: string) {
  const [pricing, setPricing] = useState<PricingData | null>(cachedPricing);
  const [loading, setLoading] = useState(!cachedPricing);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cachedPricing) {
      setPricing(cachedPricing);
      setLoading(false);
      return;
    }

    // Deduplicate concurrent requests
    if (!cachePromise) {
      cachePromise = fetch(`${serverUrl}/pricing`)
        .then((res) => {
          if (!res.ok) throw new Error("Failed to fetch pricing");
          return res.json() as Promise<PricingData>;
        })
        .then((data) => {
          cachedPricing = data;
          return data;
        })
        .catch((err) => {
          cachePromise = null;
          throw err;
        });
    }

    cachePromise
      .then((data) => {
        setPricing(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [serverUrl]);

  return { pricing, loading, error };
}
