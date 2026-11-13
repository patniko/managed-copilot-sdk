import { useCallback, useEffect, useState } from "react";
import type { ShopAvailability, Target } from "../shared/catalog.js";
import { Spinner } from "./ui.js";

const POLL_MS = 5_000;

const ago = (iso: string): string => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString();
};

/**
 * Downhill's shop, on or off, on one target: a presenter keeps it off, then rolls it out live. Opening it starts
 * launch day over, so the sales, the alert, and the incident play from the start. `target` absent: Downhill isn't up.
 */
export function ShopSwitch({ target, targetName }: { readonly target?: Target; readonly targetName?: string }) {
  const [shop, setShop] = useState<ShopAvailability>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const call = useCallback(
    async (init?: RequestInit): Promise<void> => {
      if (!target) return;
      try {
        const response = await fetch(`/api/downhill/shop?target=${target}`, { cache: "no-store", ...init });
        const body = (await response.json().catch(() => undefined)) as (ShopAvailability & { error?: string }) | undefined;
        if (!response.ok || !body) {
          setError(body?.error ?? `The gallery answered with an error (${response.status}).`);
          return;
        }
        setShop(body);
        setError(undefined);
      } catch {
        setError("Couldn't reach the gallery server.");
      }
    },
    [target],
  );

  useEffect(() => {
    setShop(undefined);
    setError(undefined);
    if (!target) return;
    void call();
    const timer = setInterval(() => void call(), POLL_MS);
    return () => clearInterval(timer);
  }, [target, call]);

  const toggle = async (): Promise<void> => {
    if (!shop) return;
    setBusy(true);
    await call({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ open: !shop.open }) });
    setBusy(false);
  };

  const label = "The Downhill Shop";
  const status = !target
    ? "Start Downhill to roll it out"
    : !shop
      ? error ?? "Checking…"
      : shop.open
        ? `Open${shop.changedAt ? `, rolled out ${ago(shop.changedAt)}` : ""}${targetName ? ` · ${targetName}` : ""}`
        : `Closed: no sales or alerts${targetName ? ` · ${targetName}` : ""}`;
  return (
    <div className="shop-switch">
      <div className="min-w-0 flex-1">
        <span id="shop-switch-label" className="block text-sm font-semibold">
          {label}
        </span>
        <span className="block text-xs text-fg-muted" aria-live="polite">
          {status}
        </span>
        {shop && error ? <span className="block text-xs text-fg-danger">{error}</span> : null}
      </div>
      {busy ? <Spinner size={16} className="text-fg-muted" label="Changing the shop" /> : null}
      <button
        type="button"
        role="switch"
        className="ToggleSwitch shrink-0"
        aria-checked={shop?.open === true}
        aria-labelledby="shop-switch-label"
        disabled={!shop || busy}
        onClick={() => void toggle()}
      />
    </div>
  );
}
