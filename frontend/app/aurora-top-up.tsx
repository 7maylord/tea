"use client";

import { Widget, WidgetConfigProvider, type WidgetConfigProviderProps } from "@aurora-is-near/intents-swap-widget-standalone";
import { useMemo, useState } from "react";

type Target = {
  label: string;
  token: NonNullable<WidgetConfigProviderProps["config"]["defaultTargetToken"]>;
};

const targets: Target[] = [
  { label: "USDC", token: { symbol: "USDC", blockchain: "monad" } },
  { label: "AUSD", token: { symbol: "AUSD", blockchain: "monad" } },
  { label: "MON", token: { symbol: "MON", blockchain: "monad" } },
];

export default function AuroraTopUp({ address }: { address: string }) {
  const apiKey = process.env.NEXT_PUBLIC_AURORA_INTENTS_API_KEY;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(targets[0]);
  const config = useMemo<WidgetConfigProviderProps["config"]>(() => ({
    apiKey,
    sendAddress: address,
    defaultTargetToken: target.token,
    allowedTargetChainsList: ["monad"],
    allowedTargetTokensList: targets.map((item) => item.label),
    slippageTolerance: 100,
    enableAccountAbstraction: true,
    showConversionPreview: true,
    showTransactionHistory: true,
    hideSendAddress: true,
    lockSwapDirection: true,
  }), [address, apiKey, target]);

  return (
    <section className="mt-5 rounded-3xl border border-stone-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-700">Top up</p>
          <h2 className="mt-1 text-xl font-semibold text-stone-950">Add Monad assets</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">Bridge into your wallet with Aurora Intents.</p>
        </div>
        <button type="button" onClick={() => setOpen((value) => !value)} className="min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">
          {open ? "Close" : "Top up"}
        </button>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {targets.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => { setTarget(item); setOpen(true); }}
            aria-pressed={target.label === item.label}
            className={`min-h-11 rounded-xl border px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 ${target.label === item.label ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 text-stone-700"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {!apiKey && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">Aurora top-up needs NEXT_PUBLIC_AURORA_INTENTS_API_KEY.</p>}
      {open && apiKey && (
        <div className="mt-5 overflow-hidden rounded-2xl border border-stone-200">
          <WidgetConfigProvider config={config} theme={{ colorScheme: "light", accentColor: "#ea580c", stylePreset: "simple" }}>
            <Widget defaultMode="topup" />
          </WidgetConfigProvider>
        </div>
      )}
    </section>
  );
}
