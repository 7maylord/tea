"use client";

import { useState } from "react";

const routes = [
  { label: "Send now", amount: "$48.00", path: "@maya → confirmed", tone: "from-emerald-300 to-lime-300" },
  { label: "Email claim", amount: "$120.00", path: "olubaba@gmail.com → escrow", tone: "from-orange-200 to-amber-300" },
  { label: "Split", amount: "$320.00", path: "4 friends → requests", tone: "from-sky-200 to-cyan-300" },
  { label: "Unlock later", amount: "$75.00", path: "Friday 9am → locked", tone: "from-violet-200 to-fuchsia-300" },
];

const features = [
  ["One passkey", "Mera derives the TEA payment account. Privy only gets you in."],
  ["Message money", "Send by handle, email, split request, stream, or date unlock."],
  ["Monad native", "Contracts, receipts, and activity are verified on Monad testnet."],
];

export default function LandingPage({ online, onLogin }: { online: boolean; onLogin: () => void }) {
  const [selected, setSelected] = useState(0);
  const route = routes[selected];

  return (
    <main className="relative isolate min-h-dvh overflow-hidden bg-[#07110b] text-white">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_20%,rgba(52,211,153,0.35),transparent_28%),radial-gradient(circle_at_78%_12%,rgba(251,146,60,0.22),transparent_26%),linear-gradient(135deg,#07110b_0%,#111827_48%,#1c1917_100%)]" />
      <div className="tea-orb left-[8%] top-24 h-40 w-40 bg-emerald-400/25" />
      <div className="tea-orb right-[10%] top-72 h-56 w-56 bg-orange-300/20 [animation-delay:1.4s]" />

      <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-6">
        <span className="text-3xl font-semibold tracking-tight">tea.</span>
        <button type="button" disabled={!online} onClick={onLogin} className="min-h-11 rounded-full border border-white/15 bg-white/10 px-5 text-sm font-semibold backdrop-blur transition hover:bg-white/20 disabled:opacity-50">Sign in</button>
      </nav>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-8 lg:grid-cols-[1.05fr_0.95fr] lg:pb-24 lg:pt-16">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100 backdrop-blur">
            <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_20px_rgba(110,231,183,0.9)]" />
            The Everything App for money on Monad
          </div>
          <h1 className="mt-7 max-w-3xl text-6xl font-semibold leading-[0.92] tracking-[-0.06em] sm:text-7xl lg:text-8xl">
            Send money like a message.
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-8 text-stone-300 sm:text-xl">
            Your email gets you in. Your passkey protects every payment. Send, split, stream, claim, and unlock test dollars from one clean TEA account.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <button type="button" disabled={!online} onClick={onLogin} className="min-h-14 rounded-2xl bg-lime-300 px-7 font-semibold text-stone-950 shadow-[0_0_50px_rgba(190,242,100,0.25)] transition hover:-translate-y-0.5 hover:bg-lime-200 disabled:opacity-50">Start with email</button>
            <a href="#how" className="inline-flex min-h-14 items-center justify-center rounded-2xl border border-white/15 px-7 font-semibold text-white transition hover:bg-white/10">See how it works</a>
          </div>
          <div className="mt-10 grid max-w-xl grid-cols-3 gap-3 text-sm text-stone-300">
            <div><p className="text-2xl font-semibold text-white">1</p><p>passkey account</p></div>
            <div><p className="text-2xl font-semibold text-white">5</p><p>payment modes</p></div>
            <div><p className="text-2xl font-semibold text-white">14d</p><p>email claim safety</p></div>
          </div>
        </div>

        <div className="tea-card-glow rounded-[2rem] border border-white/10 bg-white/[0.08] p-4 shadow-2xl backdrop-blur-xl">
          <div className="rounded-[1.5rem] bg-[#0c1510] p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-stone-400">Routing intent</p>
                <p className="mt-1 text-2xl font-semibold">{route.label}</p>
              </div>
              <span className="rounded-full bg-lime-300 px-3 py-1 text-sm font-semibold text-stone-950">Live</span>
            </div>
            <div className="mt-6 rounded-3xl border border-white/10 bg-white/[0.06] p-5">
              <p className="text-sm text-stone-400">Amount</p>
              <p className="mt-2 text-5xl font-semibold tracking-tight">{route.amount}</p>
              <div className="relative mt-7 h-3 overflow-hidden rounded-full bg-white/10">
                <div className={`tea-route-line absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${route.tone}`} />
              </div>
              <div className="mt-5 flex items-center justify-between text-sm text-stone-300">
                <span>email</span><span>passkey</span><span>contract</span><span>receipt</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {routes.map((item, index) => (
                <button key={item.label} type="button" onClick={() => setSelected(index)} aria-pressed={selected === index} className={`rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 ${selected === index ? "border-lime-300/60 bg-lime-300/10" : "border-white/10 bg-white/[0.04]"}`}>
                  <p className="font-semibold">{item.label}</p>
                  <p className="mt-1 text-sm text-stone-400">{item.path}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="mx-auto grid max-w-6xl gap-4 px-5 pb-20 md:grid-cols-3">
        {features.map(([title, text], index) => (
          <article key={title} className="tea-fade-up rounded-3xl border border-white/10 bg-white/[0.06] p-6 backdrop-blur" style={{ animationDelay: `${index * 120}ms` }}>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-lime-200">0{index + 1}</p>
            <h2 className="mt-5 text-2xl font-semibold">{title}</h2>
            <p className="mt-3 leading-7 text-stone-300">{text}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
