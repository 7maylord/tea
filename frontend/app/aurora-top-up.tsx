"use client";

import { Widget, WidgetConfigProvider, type WidgetConfigProviderProps } from "@aurora-is-near/intents-swap-widget-standalone";
import { useEffect, useMemo, useRef, useState } from "react";

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
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);
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

  function choose(item: Target) {
    setTarget(item);
    if (apiKey) setOpen(true);
  }

  return (
    <section className="mt-5 rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-700">Top up</p>
          <h2 className="mt-1 text-xl font-semibold text-stone-950">Add funds</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">Bridge USDC, AUSD, or MON to this TEA wallet.</p>
        </div>
        <button type="button" disabled={!apiKey} onClick={() => setOpen(true)} className="min-h-11 rounded-xl bg-stone-900 px-4 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">
          Top up
        </button>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {targets.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => choose(item)}
            aria-pressed={target.label === item.label}
            className={`min-h-11 rounded-xl border px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 ${target.label === item.label ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 text-stone-700"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {!apiKey && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">Aurora top-up needs NEXT_PUBLIC_AURORA_INTENTS_API_KEY.</p>}
      {open && apiKey && (
        <dialog ref={dialog} onClose={() => setOpen(false)} onCancel={() => setOpen(false)} className="fixed inset-0 m-auto max-h-[92dvh] w-[calc(100%_-_24px)] max-w-md rounded-3xl border-0 bg-transparent p-0 backdrop:bg-stone-950/55" aria-label="Top up with Aurora">
          <div className="max-h-[92dvh] w-full max-w-md overflow-hidden rounded-3xl bg-[#f6f2e9] shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-stone-200 bg-white p-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-700">Aurora Intents</p>
                <h3 className="mt-1 text-lg font-semibold text-stone-950">Top up {target.label}</h3>
                <p className="mt-1 text-xs text-stone-500">Funds arrive at your TEA wallet.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="min-h-10 rounded-xl border border-stone-300 px-3 text-sm font-semibold text-stone-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">
                Close
              </button>
            </div>
            <div className="flex gap-2 overflow-x-auto border-b border-stone-200 bg-white px-4 pb-4">
              {targets.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => setTarget(item)}
                  aria-pressed={target.label === item.label}
                  className={`min-h-10 rounded-full border px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 ${target.label === item.label ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="max-h-[72dvh] overflow-y-auto p-3">
              <div className="overflow-hidden rounded-2xl bg-white">
                <WidgetConfigProvider config={config} theme={{ colorScheme: "light", accentColor: "#ea580c" }}>
                  <Widget defaultMode="topup" />
                </WidgetConfigProvider>
              </div>
            </div>
          </div>
        </dialog>
      )}
    </section>
  );
}
