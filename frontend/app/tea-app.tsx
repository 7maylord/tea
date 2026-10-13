"use client";

import "./app-experience.css";

import { authHeaders } from "./auth";
import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { toast } from "sonner";
import Activity from "./activity";
import { useOnlineStatus } from "./pwa";
import SendFlow from "./send-flow";
import { copyMeraWallet, ensureMeraAccount, meraErrorMessage } from "./mera";

type Account = { chainId: number; address: string };
type SessionResponse = {
  id: string;
  handle: string | null;
  account: Account | null;
};
type Session = Omit<SessionResponse, 'account'> & { account: Account };
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
const AuroraTopUp = dynamic(() => import("./aurora-top-up"), {
  ssr: false,
  loading: () => <section className="mt-5 rounded-3xl border border-stone-200 bg-white p-5 shadow-sm"><p className="text-sm font-semibold text-stone-700">Loading cross-chain top up…</p></section>,
});
const MeraWallet = dynamic(() => import("./mera-wallet"), { ssr: false });

export default function TeaApp({ apiOrigin }: { apiOrigin: string }) {
  const online = useOnlineStatus();
  const { ready, authenticated, user, logout } = usePrivy();
  const [active, setActive] = useState<{ did: string; session: Session } | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [balances, setBalances] = useState<{ ownerId: string; data: Balance[] } | null>(null);
  const [selectedToken, setSelectedToken] = useState('');
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [view, setView] = useState<'home' | 'send' | 'activity' | 'profile'>('home');
  const did = user?.id;
  const session = active && active.did === did ? active.session : null;
  const visibleBalances = balances && balances.ownerId === session?.id ? balances.data : [];
  const visibleBalance = visibleBalances.find((item) => item.token === selectedToken) ?? visibleBalances[0] ?? null;
  const refreshAfterPayment = useCallback(() => setBalanceVersion((value) => value + 1), []);

  useEffect(() => {
    if (!online || !ready || !authenticated || !did) return;
    const controller = new AbortController();
    void authHeaders()
      .then((headers) => fetch(`${apiOrigin}/v1/session/sync`, {
        method: 'POST',
        headers,
        signal: controller.signal,
      }))
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not finish account setup. Try again.');
        return (await response.json()) as SessionResponse;
      })
      .then(async (session) => {
        if (session.account) return session;
        const mera = await ensureMeraAccount({
          ownerId: did,
          did,
          chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID),
          email: user?.email?.address,
          handle: session.handle,
        });
        const response = await fetch(`${apiOrigin}/v1/session/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...await authHeaders() },
          body: JSON.stringify({ accountAddress: mera.address, signature: mera.signature }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Could not create your payment account. Try again.');
        return (await response.json()) as SessionResponse;
      })
      .then((session) => {
        if (!session.account) throw new Error('Could not create your payment account. Try again.');
        copyMeraWallet(did, session.id);
        setActive({ did, session: { ...session, account: session.account } });
        setError('');
        toast.dismiss('account-setup');
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          const message = meraErrorMessage(cause);
          setError(message);
          toast.error(message, { id: 'account-setup' });
        }
      });
    return () => controller.abort();
  }, [apiOrigin, authenticated, did, online, ready, retry, user?.email?.address]);

  useEffect(() => {
    if (!online || view !== 'home' || !session?.handle || !session.account) return;
    const controller = new AbortController();
    void authHeaders()
      .then((headers) => fetch(`${apiOrigin}/v1/balances`, {
        headers,
        cache: 'no-store',
        signal: controller.signal,
      }))
      .then(async (response) => {
        if (!response.ok) throw new Error('Balance unavailable');
        return (await response.json()) as Balance[];
      })
      .then((data) => {
        setBalances({ ownerId: session.id, data });
        setSelectedToken((current) => data.some((item) => item.token === current) ? current : (data[0]?.token ?? ''));
      })
      .catch(() => {
        if (!controller.signal.aborted) toast.error('Could not refresh your balance. Try again.', { id: 'balance-refresh' });
      });
    return () => controller.abort();
  }, [apiOrigin, balanceVersion, online, session?.account, session?.handle, session?.id, view]);

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
      setBalances(null);
      setSelectedToken('');
      setView('home');
    } catch {
      toast.error('Could not sign out. Try again.', { id: 'sign-out' });
    } finally {
      setBusy(false);
    }
  }

  async function reserveHandle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      toast.error('Use 3–20 lowercase letters, numbers, or underscores.', { id: 'handle' });
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
      toast.success(`@${handle} is yours.`, { id: 'handle' });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not save your handle.', { id: 'handle' });
    } finally {
      setBusy(false);
    }
  }

  async function claimFaucet() {
    setFaucetBusy(true);
    toast.loading('Claiming test funds…', { id: 'faucet' });
    try {
      const response = await fetch(`${apiOrigin}/v1/faucet/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...await authHeaders() },
        body: JSON.stringify({ token: visibleBalance?.token }),
      });
      if (response.status === 409) throw new Error('You already claimed today.');
      if (!response.ok) throw new Error('Could not claim test funds. Try again.');
      toast.success(`10,000 ${visibleBalance?.symbol ?? 'tokens'} claimed.`, { id: 'faucet' });
      setBalanceVersion((value) => value + 1);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not claim test funds.', { id: 'faucet' });
    } finally {
      setFaucetBusy(false);
    }
  }

  const address = session?.account.address;

  if (ready && !authenticated) return <main className="tea-workspace tea-workspace--setup"><section className="tea-workspace-content"><h1 className="tea-page-title">Your session ended.</h1><p className="tea-page-intro">Return home to sign in again.</p><Link href="/" className={`${primary} mt-6 inline-flex items-center justify-center`}>Go to TEA</Link></section></main>;

  return (
    <main className={`tea-workspace tea-workspace--${session?.handle ? view : "setup"}`}>
      <header className="tea-workspace-header">
        <Link href="/" className="tea-wordmark" aria-label="Go to TEA homepage">tea<span>.</span></Link>
        <span className="tea-network"><span aria-hidden="true" />Monad testnet</span>
        {ready && authenticated && !session?.handle && <button type="button" disabled={busy} onClick={() => void signOut()} className="min-h-11 rounded-full px-3 text-sm font-medium text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:opacity-50">Sign out</button>}
      </header>

      <section className="tea-workspace-content">
        {!ready ? (
          <p role="status" className="text-stone-600">Getting TEA ready…</p>
        ) : !session ? (
          <>
            <h1 className="text-3xl font-semibold">Preparing your TEA account</h1>
            <p className="mt-3 text-stone-600">Returning users go straight in. On your first visit, your passkey creates your payment wallet.</p>
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
              <p className="tea-eyebrow">Your everyday, all together</p>
              <h1 className="tea-page-title">Hello, {session.handle}.</h1>
              <p className="tea-page-intro">A little more flow. A little less friction.</p>
              <div className="tea-balance" onPointerMove={(event) => {
                if (event.pointerType !== 'mouse' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                event.currentTarget.style.setProperty('--light-x', `${event.clientX - bounds.left}px`);
                event.currentTarget.style.setProperty('--light-y', `${event.clientY - bounds.top}px`);
              }}>
                <div className="tea-balance-rings" aria-hidden="true"><i /><i /><i /></div>
                <div className="tea-balance-top"><span className="tea-eyebrow">TEA wallet</span><span className="tea-wallet-mark" aria-hidden="true">↗</span></div>
                <div className="mt-4 flex gap-2" aria-label="Settlement token">
                  {visibleBalances.map((item) => <button key={item.token} type="button" aria-pressed={item.token === visibleBalance?.token} onClick={() => setSelectedToken(item.token)} className={`min-h-10 rounded-full px-4 text-sm font-semibold ${item.token === visibleBalance?.token ? 'bg-white text-[#173e32]' : 'border border-white/40 text-white'}`}>{item.symbol}</button>)}
                </div>
                <p className="tea-balance-label">Available balance</p>
                <p className="tea-balance-amount">{visibleBalance ? `${formatAmount(visibleBalance.balanceUnits, visibleBalance.decimals)} ${visibleBalance.symbol}` : 'Checking…'}</p>
                <div className="tea-balance-actions">
                  <button type="button" onClick={() => setBalanceVersion((value) => value + 1)} className="min-h-11 rounded-xl border border-stone-500 px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">Refresh balance</button>
                  <button type="button" disabled={faucetBusy || !online || !visibleBalance} onClick={() => void claimFaucet()} className="min-h-11 rounded-xl bg-white px-4 text-sm font-semibold text-stone-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">{faucetBusy ? 'Claiming…' : `Claim 10,000 ${visibleBalance?.symbol ?? ''}`}</button>
                </div>
              </div>
              <button type="button" onClick={() => setView('send')} className="tea-send-action"><span><span className="tea-action-label">Make someone’s day</span>Send money</span><span className="tea-action-arrow" aria-hidden="true">↗</span></button>
              <AuroraTopUp address={session.account.address} />
            </>}
            {view === 'send' && <SendFlow apiOrigin={apiOrigin} userId={session.id} address={session.account.address} chainId={session.account.chainId} balance={visibleBalance} onBack={() => setView('home')} onSettled={refreshAfterPayment} />}
            {view === 'activity' && <Activity key={session.id} apiOrigin={apiOrigin} userId={session.id} address={session.account.address} chainId={session.account.chainId} balances={visibleBalances} onSettled={refreshAfterPayment} />}
            {view === 'profile' && <>
              <p className="tea-eyebrow">Personally yours</p>
              <h1 className="tea-page-title">Your little corner.</h1>
              <p className="tea-page-intro">Your identity, your wallet, your keys.</p>
              <div className="tea-profile-card">
                <div className="tea-profile-avatar" aria-hidden="true">{session.handle.slice(0, 2).toUpperCase()}</div>
                <p className="tea-eyebrow">TEA name</p>
                <p className="mt-1 font-semibold">@{session.handle}</p>
                <p className="mt-5 text-sm text-stone-500">Verified email</p>
                <p className="mt-1 break-all font-medium">{user?.email?.address ?? 'Unavailable'}</p>
                <p className="mt-5 text-sm text-stone-500">Settlement wallet</p>
                <p className="mt-1 break-all font-mono text-sm text-stone-800">{address}</p>
                <p className="mt-3 text-xs text-stone-500">Network ID {session.account.chainId}</p>
              </div>
              <MeraWallet ownerId={session.id} did={did!} chainId={session.account.chainId} handle={session.handle} email={user?.email?.address} />
              <button type="button" disabled={busy} onClick={() => void signOut()} className="mt-5 min-h-12 rounded-2xl border border-stone-300 px-5 font-medium text-stone-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 disabled:opacity-50">Sign out</button>
            </>}
          </>
        )}
      </section>
      {session?.handle && view !== 'send' && <nav aria-label="Main" className="tea-app-nav">
        {(['home', 'activity', 'profile'] as const).map((item) => <button key={item} type="button" aria-current={view === item ? 'page' : undefined} onClick={() => { setView(item); setError(''); }} className={`min-h-12 rounded-xl px-2 text-sm font-semibold capitalize focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 ${view === item ? 'bg-stone-900 text-white' : 'text-stone-600'}`}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={item === 'home' ? 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z' : item === 'activity' ? 'M3 12h4l3-8 4 16 3-8h4' : 'M5 21v-2a7 7 0 0 1 14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0'} /></svg>{item}</button>)}
      </nav>}
    </main>
  );
}
