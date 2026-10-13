"use client";

import { useMemo, useState, type FormEvent } from "react";
import { formatUnits, parseUnits } from "viem";
import { toast } from "sonner";
import { authHeaders } from "./auth";

type Balance = { token: string; decimals: number; symbol: string };
type Split = {
  id: string;
  title: string | null;
  totalAmountUnits: string;
  obligations: { id: string; participantHandle: string | null; amountUnits: string; state: string }[];
};
type Row = { person: string; amount: string };
const button = "min-h-12 rounded-2xl bg-stone-900 px-6 font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900";

export default function SplitSend({ apiOrigin, balance, onSettled }: { apiOrigin: string; balance: Balance | null; onSettled: () => void }) {
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Row[]>([{ person: "", amount: "" }, { person: "", amount: "" }]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Split | null>(null);
  const preparedRows = useMemo(() => {
    if (!balance) return [];
    return rows.map((row) => {
      try {
        const person = row.person.trim();
        const amount = row.amount.trim() ? parseUnits(row.amount, balance.decimals) : BigInt(0);
        return { person, amount };
      } catch {
        return { person: row.person.trim(), amount: null };
      }
    });
  }, [balance, rows]);
  const total = preparedRows.reduce((sum, row) => sum + (typeof row.amount === "bigint" ? row.amount : BigInt(0)), BigInt(0));

  async function authed(path: string, options: RequestInit = {}) {
    const response = await fetch(`${apiOrigin}${path}`, {
      ...options,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...await authHeaders(), ...options.headers },
    });
    if (!response.ok) throw new Error(response.status === 404 ? "A TEA name was not found." : response.status === 410 ? "A recipient lookup expired. Try again." : "Split is unavailable. Try again.");
    return response.json() as Promise<unknown>;
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!balance) { toast.error("Refresh your balance before creating a split.", { id: "split-create" }); return; }
    const validRows = preparedRows.filter((row) => row.person || (typeof row.amount === "bigint" && row.amount > BigInt(0)));
    if (validRows.length < 1 || validRows.length > 20) { toast.error("Add 1–20 people.", { id: "split-create" }); return; }
    if (validRows.some((row) => !row.person || typeof row.amount !== "bigint" || row.amount <= BigInt(0))) { toast.error("Each person needs a TEA name and amount.", { id: "split-create" }); return; }
    setBusy(true);
    toast.loading("Creating split requests…", { id: "split-create" });
    try {
      const obligations = await Promise.all(validRows.map(async (row) => {
        if (typeof row.amount !== "bigint") throw new Error("Enter a valid amount for each person.");
        const raw = row.person;
        const kind = raw.includes("@") ? "email" : "handle";
        const value = kind === "handle" ? raw.toLowerCase() : raw;
        const result = await authed("/v1/resolve", { method: "POST", body: JSON.stringify({ kind, value }) }) as { kind: string; reference?: string };
        if (result.kind !== "existing" || !result.reference) throw new Error(`${raw} is not a TEA member yet.`);
        return { recipientReference: result.reference, amountUnits: row.amount.toString() };
      }));
      const split = await authed("/v1/splits", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ title: title.trim() || undefined, obligations, token: balance.token }),
      }) as Split;
      setCreated(split);
      setTitle("");
      setRows([{ person: "", amount: "" }, { person: "", amount: "" }]);
      toast.success("Split requests created.", { id: "split-create" });
      onSettled();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not create split.", { id: "split-create" });
    } finally { setBusy(false); }
  }

  return <>
    {created && <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
      <p className="font-semibold">Split created</p>
      <p className="mt-2 text-sm text-stone-600">Each member will see a request to pay you.</p>
      <div className="mt-4 space-y-2">{created.obligations.map((obligation) => <div key={obligation.id} className="flex justify-between gap-3 text-sm"><span>{obligation.participantHandle ? `@${obligation.participantHandle}` : "TEA member"}</span><span className="font-semibold">{formatUnits(BigInt(obligation.amountUnits), balance?.decimals ?? 6)} {balance?.symbol ?? "TUSD"}</span></div>)}</div>
    </div>}
    <form onSubmit={(event) => void create(event)} className="mt-8 flex flex-col gap-4">
      <label htmlFor="split-title" className="font-medium">What is this for?</label>
      <input id="split-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} className="min-h-14 rounded-2xl border border-stone-300 bg-white px-4" placeholder="Dinner, rent, trip…" />
      <fieldset className="space-y-3">
        <legend className="font-medium">People and amounts</legend>
        {rows.map((row, index) => <div key={index} className="grid gap-2 rounded-2xl border border-stone-200 bg-white p-3">
          <label className="sr-only" htmlFor={`split-person-${index}`}>Person {index + 1}</label>
          <input id={`split-person-${index}`} autoCapitalize="none" autoComplete="off" spellCheck={false} value={row.person} onChange={(event) => setRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, person: event.target.value } : item))} className="min-h-12 rounded-xl bg-stone-50 px-3 outline-none" placeholder="TEA name or email" />
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <label className="sr-only" htmlFor={`split-amount-${index}`}>Amount for person {index + 1}</label>
            <input id={`split-amount-${index}`} inputMode="decimal" autoComplete="off" value={row.amount} onChange={(event) => setRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, amount: event.target.value } : item))} className="min-h-12 rounded-xl bg-stone-50 px-3 outline-none" placeholder={`Amount in ${balance?.symbol ?? "TUSD"}`} />
            {rows.length > 1 && <button type="button" onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} className="min-h-12 rounded-xl px-3 text-sm font-semibold text-stone-500">Remove</button>}
          </div>
        </div>)}
      </fieldset>
      <button type="button" disabled={rows.length >= 20} onClick={() => setRows((current) => [...current, { person: "", amount: "" }])} className="min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50">Add person</button>
      <p className="rounded-2xl bg-stone-100 p-4 text-sm text-stone-700">Total requested: <span className="font-semibold">{balance ? `${formatUnits(total, balance.decimals)} ${balance.symbol}` : "—"}</span></p>
      <button type="submit" disabled={busy || !balance} className={button}>{busy ? "Creating…" : "Create split"}</button>
    </form>
  </>;
}
