"use client";

import { authHeaders } from "./auth";
import {
  useCreateWallet,
  usePrivy,
  useUser,
} from "@privy-io/react-auth";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Activity from "./activity";
import { useOnlineStatus } from "./pwa";
import SendFlow from "./send-flow";
import AuroraTopUp from "./aurora-top-up";

type Session = {
  id: string;
  handle: string | null;
  account: { chainId: number; address: string };
};
type Balance = {
  token: string;
  symbol: string;
  decimals: number;
  balanceUnits: string;
  blockNumber: string;
};

function formatAmount(units: string, decimals: number) {
  const value = BigInt(units);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = (value / base).toString();
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

const primary = 'min-h-12 rounded-2xl bg-stone-900 px-6 font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900';

export default function TeaApp({ apiOrigin }: { apiOrigin: string }) {
  const online = useOnlineStatus();
  const { ready, authenticated, user, login, logout, linkPasskey } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { refreshUser } = useUser();
  const [active, setActive] = useState<{ did: string; session: Session } | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [balance, setBalance] = useState<{ ownerId: string; data: Balance } | null>(null);
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'home' | 'send' | 'activity' | 'profile'>('home');
  const did = user?.id;
  const passkeysAvailable = typeof window !== 'undefined' && 'PublicKeyCredential' in window;
  const hasWallet = user?.linkedAccounts.some(
    (account) => account.type === 'wallet' && account.chainType === 'ethereum' &&
      (account.walletClientType === 'privy' || account.walletClientType === 'privy-v2'),
  );
  const hasPasskey = user?.linkedAccounts.some((account) => account.type === 'passkey');
  const session = active && active.did === did ? active.session : null;
  const visibleBalance = balance && balance.ownerId === session?.id ? balance.data : null;
  const refreshAfterPayment = useCallback(() => setBalanceVersion((value) => value + 1), []);

  useEffect(() => {
    if (!online || !ready || !authenticated || !did || !hasWallet) return;
    const controller = new AbortController();
    void authHeaders()
      .then((headers) => fetch(`${apiOrigin}/v1/session/sync`, {
        method: 'POST',
        headers,
        signal: controller.signal,
      }))
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not finish account setup. Try again.');
        return (await response.json()) as Session;
      })
      .then((session) => { setActive({ did, session }); setError(''); })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not finish account setup. Try again.');
      });
    return () => controller.abort();
  }, [apiOrigin, authenticated, did, hasWallet, online, ready, retry]);

  useEffect(() => {
    if (!online || view !== 'home' || !session?.handle) return;
    const controller = new AbortController();
    void authHeaders()
      .then((headers) => fetch(`${apiOrigin}/v1/balance`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      }))
      .then(async (response) => {
        if (!response.ok) throw new Error('Balance unavailable');
        return (await response.json()) as Balance;
      })
      .then((data) => setBalance({ ownerId: session.id, data }))
      .catch(() => {
        if (!controller.signal.aborted) setError('Could not refresh your balance. Try again.');
      });
    return () => controller.abort();
  }, [apiOrigin, balanceVersion, online, session?.handle, session?.id, view]);

  async function finishWallet() {
    setBusy(true);
    setError('');
    try {
      await createWallet();
      await refreshUser();
    } catch {
      setError('Could not create your wallet. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await logout();
      if (session) {
        sessionStorage.removeItem(`tea:payment:${session.id}`);
        sessionStorage.removeItem(`tea:payment-draft:${session.id}`);
        sessionStorage.removeItem(`tea:claim:${session.id}`);
        sessionStorage.removeItem(`tea:claim-draft:${session.id}`);
        sessionStorage.removeItem(`tea:stream:${session.id}`);
        sessionStorage.removeItem(`tea:stream-draft:${session.id}`);
        sessionStorage.removeItem(`tea:date-lock:${session.id}`);
        sessionStorage.removeItem(`tea:date-lock-draft:${session.id}`);
        sessionStorage.removeItem(`tea:send-review:${session.id}`);
        for (let index = sessionStorage.length - 1; index >= 0; index--) {
          const key = sessionStorage.key(index);
          if (key?.startsWith(`tea:stream-action:${session.id}:`) || key?.startsWith(`tea:date-lock-action:${session.id}:`)) sessionStorage.removeItem(key);
        }
      }
      setActive(null);
      setHandle('');
      setError('');
      setBalance(null);
      setNotice('');
      setView('home');
    } catch {
      setError('Could not sign out. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function reserveHandle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      setError('Use 3–20 lowercase letters, numbers, or underscores.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${apiOrigin}/v1/me/handle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...await authHeaders() },
        body: JSON.stringify({ handle }),
      });
      if (response.status === 409) {
        setRetry((value) => value + 1);
        throw new Error('That handle is unavailable. Try another.');
      }
      if (!response.ok) throw new Error('Could not save your handle. Try again.');
      setActive((current) => current && current.did === did
        ? { ...current, session: { ...current.session, handle } }
        : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your handle.');
    } finally {
      setBusy(false);
    }
  }



  const address = session?.account.address;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(28px,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between">
        <span className="text-3xl font-semibold tracking-tight">tea.</span>
        {ready && authenticated && !session?.handle && <button type="button" disabled={busy} onClick={() => void signOut()} className="min-h-11 rounded-full px-3 text-sm font-medium text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:opacity-50">Sign out</button>}
      </header>

      <section className="flex flex-1 flex-col justify-center py-12">
        {!ready ? (
          <p role="status" className="text-stone-600">Getting TEA ready…</p>
        ) : !authenticated ? (
          <>
            <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-orange-700">Money, together</p>
            <h1 className="text-5xl font-semibold leading-[1.06] tracking-tight">Send dollars like a message.</h1>
            <p className="mt-6 text-lg leading-7 text-stone-600">Start with your email. Your wallet comes with you.</p>
            <button type="button" disabled={!online} onClick={() => login()} className={`${primary} mt-10`}>Continue with email</button>
          </>
        ) : !hasWallet ? (
          <>
            <h1 className="text-3xl font-semibold">Finish setting up your wallet</h1>
            <p className="mt-3 text-stone-600">You can receive money after your wallet is ready.</p>
            <button type="button" disabled={busy || !online} onClick={() => void finishWallet()} className={`${primary} mt-8`}>{busy ? 'Setting up…' : 'Finish wallet setup'}</button>
          </>
        ) : !session ? (
          <>
            <h1 className="text-3xl font-semibold">Preparing your account</h1>
            <p className="mt-3 text-stone-600">This usually takes a moment.</p>
            {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            {error && <button type="button" onClick={() => setRetry((value) => value + 1)} className={`${primary} mt-6`}>Try again</button>}
          </>
        ) : !session.handle ? (
          <>
            <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-orange-700">One last step</p>
            <h1 className="text-4xl font-semibold tracking-tight">Choose your TEA name.</h1>
            <p className="mt-4 text-stone-600">Friends can use it to find you. You cannot change it later.</p>
            <form onSubmit={(event) => void reserveHandle(event)} className="mt-8 flex flex-col gap-4">
              <label htmlFor="handle" className="font-medium">Your handle</label>
              <div className="flex min-h-14 items-center rounded-2xl border border-stone-300 bg-white px-4 focus-within:border-stone-900">
                <span aria-hidden="true" className="text-stone-500">@</span>
                <input id="handle" name="handle" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={20} pattern="[a-z0-9_]{3,20}" value={handle} onChange={(event) => setHandle(event.target.value)} className="w-full bg-transparent px-2 py-3 text-base outline-none" />
              </div>
              <button type="submit" disabled={busy || !online} className={primary}>{busy ? 'Saving…' : 'Claim handle'}</button>
            </form>
          </>
        ) : (
          <>
            {view === 'home' && <>
              <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-orange-700">Account ready</p>
              <h1 className="text-4xl font-semibold tracking-tight">Hello, {session.handle}.</h1>
              <div className="mt-8 rounded-3xl bg-stone-900 p-6 text-white">
                <p className="text-sm text-stone-300">Onchain balance</p>
                <p className="mt-3 break-all text-3xl font-semibold">{visibleBalance ? `${formatAmount(visibleBalance.balanceUnits, visibleBalance.decimals)} ${visibleBalance.symbol}` : 'Checking…'}</p>
                <button type="button" onClick={() => setBalanceVersion((value) => value + 1)} className="mt-4 min-h-11 rounded-xl border border-stone-500 px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">Refresh balance</button>
              </div>
              <button type="button" onClick={() => setView('send')} className={`${primary} mt-5`}>Send money</button>
              <AuroraTopUp address={session.account.address} />
            </>}
            {view === 'send' && <SendFlow apiOrigin={apiOrigin} userId={session.id} address={session.account.address} chainId={session.account.chainId} balance={visibleBalance} onBack={() => setView('home')} onSettled={refreshAfterPayment} />}
            {view === 'activity' && <Activity key={session.id} apiOrigin={apiOrigin} userId={session.id} address={session.account.address} chainId={session.account.chainId} balance={visibleBalance} onSettled={refreshAfterPayment} />}
            {view === 'profile' && <>
              <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-orange-700">Your account</p>
              <h1 className="text-4xl font-semibold tracking-tight">Profile</h1>
              <div className="mt-8 rounded-3xl border border-stone-200 bg-white p-5">
                <p className="text-sm text-stone-500">TEA name</p>
                <p className="mt-1 font-semibold">@{session.handle}</p>
                <p className="mt-5 text-sm text-stone-500">Verified email</p>
                <p className="mt-1 break-all font-medium">{user?.email?.address ?? 'Unavailable'}</p>
                <p className="mt-5 text-sm text-stone-500">Settlement wallet</p>
                <p className="mt-1 break-all font-mono text-sm text-stone-800">{address}</p>
                <p className="mt-3 text-xs text-stone-500">Network ID {session.account.chainId}</p>
              </div>
              {!hasPasskey && passkeysAvailable && <button type="button" disabled={!online} onClick={() => linkPasskey()} className="mt-6 min-h-12 rounded-2xl border border-stone-300 px-5 font-medium text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:opacity-50">Add a passkey for easier sign-in</button>}
              <button type="button" disabled={busy} onClick={() => void signOut()} className="mt-5 min-h-12 rounded-2xl border border-stone-300 px-5 font-medium text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:opacity-50">Sign out</button>
            </>}
          </>
        )}
        {notice && <p role="status" className="mt-5 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
        {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      </section>
      {session?.handle && view !== 'send' && <nav aria-label="Main" className="sticky bottom-0 -mx-5 grid grid-cols-3 gap-2 border-t border-stone-200 bg-[#f6f2e9] px-5 py-2">
        {(['home', 'activity', 'profile'] as const).map((item) => <button key={item} type="button" aria-current={view === item ? 'page' : undefined} onClick={() => { setView(item); setError(''); setNotice(''); }} className={`min-h-12 rounded-xl px-2 text-sm font-semibold capitalize focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 ${view === item ? 'bg-stone-900 text-white' : 'text-stone-600'}`}>{item}</button>)}
      </nav>}
    </main>
  );
}
