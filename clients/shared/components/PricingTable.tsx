import type { ServicePricing } from "../hooks/usePricing";

interface PricingTableProps {
  pricing: ServicePricing | undefined;
  loading: boolean;
}

export function PricingTable({ pricing, loading }: PricingTableProps) {
  if (loading) {
    return (
      <details className="pricing-details">
        <summary>Pricing Guide</summary>
        <div className="pricing-content">
          <p className="pricing-note">Loading pricing...</p>
        </div>
      </details>
    );
  }

  if (!pricing) {
    return null;
  }

  return (
    <details className="pricing-details">
      <summary>Pricing Guide</summary>
      <div className="pricing-content">
        <table className="pricing-table">
          <thead>
            <tr>
              <th>Request Type</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="free-tier">{pricing.freeTier.description}</td>
              <td className="free-tier">FREE</td>
            </tr>
            {pricing.examples.map((example, i) => (
              <tr key={i}>
                <td>{example.description}</td>
                <td>{example.cost}</td>
              </tr>
            ))}
            {pricing.modifiers.map((mod, i) => (
              <tr key={`mod-${i}`}>
                <td>{mod.description}</td>
                <td>{mod.effect}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pricing-note">{pricing.note}</p>
      </div>
    </details>
  );
}
