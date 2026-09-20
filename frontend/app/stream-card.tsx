"use client";

import { getIdentityToken, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { createPublicClient, custom, formatUnits, type Hex } from "viem";
import { useCallback, useEffect, useMemo, useState } from "react";
import { checkedStreamAction, type StreamAction, type StreamIntent } from "./stream-plan";

type StreamDetail = StreamIntent & { chainState: null | {
  start: string; end: string; withdrawnUnits: string; canceled: boolean;
  recipientEntitlementUnits: string | null; withdrawableUnits: string;
  blockNumber: string; blockTimestamp: string;
} };

export default function StreamCard({ id, apiOrigin, decimals = 6 }: { id: string; apiOrigin: string; decimals?: number }) {
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const [stream, setStream] = useState<StreamDetail | null>(null);
  const [clock, setClock] = useState(0);
  const [anchor, setAnchor] = useState<{ chainTimestamp: number; monotonic: number } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = useCallback(async () => {
    const token = await getIdentityToken();
    if (!token) return;
    const response = await fetch(`${apiOrigin}/v1/streams/${id}`, { headers: { "privy-id-token": token }, cache: "no-store" });
    if (response.ok) {
      const next = await response.json() as StreamDetail;
      setStream(next);
      if (next.chainState) setAnchor({ chainTimestamp: Number(next.chainState.blockTimestamp), monotonic: performance.now() });
      setError("");
    }
  }, [apiOrigin, id]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    const tick = window.setInterval(() => setClock(performance.now()), 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(refresh); window.clearInterval(tick); };
  }, [load]);
  const estimate = useMemo(() => {
    if (!stream?.chainState || !anchor) return null;
    const state = stream.chainState, deposit = BigInt(stream.amountUnits), start = BigInt(state.start), end = BigInt(state.end);
    const chainNow = BigInt(anchor.chainTimestamp + Math.max(0, Math.floor((clock - anchor.monotonic) / 1000)));
    const at = chainNow <= start ? BigInt(0) : chainNow >= end ? end - start : chainNow - start;
    const vested = state.canceled && state.recipientEntitlementUnits !== null
      ? BigInt(state.recipientEntitlementUnits) : deposit * at / (end - start);
    return { vested, available: vested > BigInt(state.withdrawnUnits) ? vested - BigInt(state.withdrawnUnits) : BigInt(0) };
  }, [anchor, clock, stream]);
  async function act(kind: "withdraw" | "cancel") {
    if (!stream?.streamId) return;
    setBusy(true); setError("");
    try {
      const identity = await getIdentityToken();
      if (!identity) throw new Error("Sign in again.");
      const response = await fetch(`${apiOrigin}/v1/streams/${id}/${kind}`, { method: "POST", headers: { "privy-id-token": identity, "Idempotency-Key": crypto.randomUUID() } });
      if (!response.ok) throw new Error(kind === "withdraw" ? "Nothing is available to collect yet." : "This stream can no longer be stopped.");
      const action = await response.json() as StreamAction;
      const wallet = wallets.find((item) => item.address.toLowerCase() === action.plan.from.toLowerCase());
      if (!wallet) throw new Error("Settlement wallet unavailable.");
      const plan = checkedStreamAction(action, wallet.address, stream.streamContract, stream.chainId, stream.streamId);
      const sent = await sendTransaction({ to: plan.to as Hex, data: plan.data, value: BigInt(0), chainId: stream.chainId }, { address: wallet.address, sponsor: stream.chainId !== 31337 });
      const receipt = await createPublicClient({ transport: custom(await wallet.getEthereumProvider()) }).waitForTransactionReceipt({ hash: sent.hash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error("Transaction failed.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Stream action failed."); }
    finally { setBusy(false); }
  }
  if (!stream?.chainState || !estimate) return <p role="status" className="mt-3 text-sm text-stone-600">Loading stream details…</p>;
  const walletAddress = wallets.find((item) => [stream.sender, stream.recipient].includes(item.address.toLowerCase()))?.address.toLowerCase();
  const canCollect = walletAddress === stream.recipient && estimate.available > BigInt(0);
  const canCancel = walletAddress === stream.sender && !stream.chainState.canceled && (!anchor || anchor.chainTimestamp + Math.max(0, Math.floor((clock - anchor.monotonic) / 1000)) < Number(stream.chainState.end));
  return <div className="mt-4 rounded-xl bg-stone-50 p-4"><div className="grid grid-cols-2 gap-4"><div><p className="text-xs text-stone-500">Accrued estimate</p><p className="mt-1 font-semibold">{formatUnits(estimate.vested, decimals)}</p></div><div><p className="text-xs text-stone-500">Collected</p><p className="mt-1 font-semibold">{formatUnits(BigInt(stream.chainState.withdrawnUnits), decimals)}</p></div></div><p className="mt-3 text-xs text-stone-500">{stream.chainState.canceled ? "Accrual stopped" : `Ends ${new Date(Number(stream.chainState.end) * 1000).toLocaleString()}`} · checked at block {stream.chainState.blockNumber}</p><div className="mt-4 flex gap-2">{canCollect && <button type="button" disabled={busy} onClick={() => void act("withdraw")} className="min-h-11 rounded-xl bg-stone-900 px-4 text-sm font-semibold text-white disabled:opacity-50">Collect {formatUnits(estimate.available, decimals)}</button>}{canCancel && <button type="button" disabled={busy} onClick={() => void act("cancel")} className="min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50">Stop stream</button>}</div>{error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}</div>;
}
