"use client";

import { useState, type PointerEvent } from "react";
import "./landing.css";

const modes = [
  { name: "Send", icon: "↗", heading: "A little something.", amount: "48.00", to: "To Maya", status: "Delivered", detail: "A handle. An amount. And you're there.", caption: "For the coffee. For the favor. Just because." },
  { name: "Email", icon: "@", heading: "You've got money.", amount: "120.00", to: "To maya@example.com", status: "Ready to claim", detail: "Send first. They can join later.", caption: "Your recipient verifies their email to collect. Unclaimed funds become refundable after 14 days." },
  { name: "Split", icon: "÷", heading: "Good times. All square.", amount: "80.00", to: "Maya's share · 4 friends", status: "Request created", detail: "One dinner. Everyone's own share.", caption: "Split equally or set a different amount for each person. Keep every request together." },
  { name: "Stream", icon: "≈", heading: "Let it flow.", amount: "240.00", to: "To Maya · over 30 days", status: "Streaming", detail: "A payment that moves with time.", caption: "Set the amount and duration. Funds become available as the stream progresses." },
  { name: "Unlock", icon: "◷", heading: "Right on time.", amount: "75.00", to: "To Maya · on Friday", status: "Date locked", detail: "Something to look forward to.", caption: "Choose a date for funds to become available. A future gift, already taken care of." },
];

export default function LandingPage({ online, onLogin }: { online: boolean; onLogin: () => void }) {
  const [selected, setSelected] = useState(0);
  const mode = modes[selected];
  function reactToPointer(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse") return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    event.currentTarget.style.setProperty("--pointer-x", `${x * 100}%`);
    event.currentTarget.style.setProperty("--pointer-y", `${y * 100}%`);
    event.currentTarget.style.setProperty("--tilt", `${(x - .5) * 7}deg`);
  }

  return (
    <main className="landing">
      <nav className="landing-nav" aria-label="Main navigation">
        <a href="#" className="landing-logo" aria-label="TEA home">tea<span>✳</span></a>
        <div className="landing-nav-links"><a href="#possibilities">The possibilities</a><a href="#how">Made for you</a></div>
        <button type="button" disabled={!online} onClick={onLogin} className="landing-nav-cta">Open TEA <span aria-hidden="true">↗</span></button>
      </nav>

      <section className="landing-hero">
        <div className="landing-hero-copy">
          <p className="landing-eyebrow"><span className="landing-dot" /> THE EVERYTHING APP FOR MONEY</p>
          <h1>Money with<br />a <em>human</em> touch<span className="landing-period">.</span></h1>
          <p className="landing-intro">For your people. For your plans. For the everyday.<br className="landing-desktop-break" /> Send, split, and let money flow — all from one place.</p>
          <button type="button" disabled={!online} onClick={onLogin} className="landing-primary">Continue with email <span aria-hidden="true">↗</span></button>
          <p className="landing-login-note">Your email gets you in. Your passkey makes it yours.</p>
          {!online && <p role="status" className="landing-offline">You’re offline. Reconnect to open your account.</p>}
          <div className="landing-hero-foot"><span>BUILT FOR REAL LIFE</span><a href="#possibilities">A little less friction. A lot more possibility. ↓</a></div>
        </div>

        <div className="landing-playground" onPointerMove={reactToPointer} onPointerLeave={(event) => event.currentTarget.style.setProperty("--tilt", "0deg")}>
          <div className="landing-playground-label"><span>THE MONEY PLAYGROUND</span><span>01 — 05</span></div>
          <div className="landing-orbit" aria-hidden="true"><i /><i /><i /><span className="landing-orbit-star">✳</span><span className="landing-orbit-plus">+</span></div>
          <div className="landing-person landing-person-you"><span>Y</span>You</div>
          <div className="landing-person landing-person-maya"><span>M</span>Maya</div>
          <article className="landing-receipt" aria-live="polite" aria-atomic="true">
            <div key={mode.name} className="landing-receipt-content">
              <div className="landing-receipt-top"><span className="landing-receipt-logo">tea</span><span>EXAMPLE PAYMENT</span></div>
              <p className="landing-receipt-title">{mode.heading}</p>
              <p className="landing-receipt-amount">{mode.amount}<span>TUSD</span></p>
              <p className="landing-receipt-to">{mode.to}</p>
              <div className="landing-receipt-bottom"><span className="landing-receipt-status"><span aria-hidden="true">{mode.icon}</span> {mode.status}</span><span aria-hidden="true">✳</span></div>
            </div>
          </article>
          <div className="landing-mode-picker" role="group" aria-label="Explore payment types">
            {modes.map((item, index) => <button key={item.name} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}><span aria-hidden="true">{item.icon}</span>{item.name}</button>)}
          </div>
          <p className="landing-playground-hint">A tiny preview. Pick a way to pay.</p>
        </div>
      </section>

      <div className="landing-network"><span><span className="landing-dot" /> MONAD TESTNET</span><p>A new rhythm for everyday money.</p><span>EMAIL IN. PASSKEY PROTECTED.</span></div>

      <section id="possibilities" className="landing-possibilities">
        <div className="landing-section-heading"><p className="landing-eyebrow">01 / A LITTLE MORE POSSIBLE</p><h2>Life doesn’t move<br />in <em>one direction.</em><br />Neither should money.</h2></div>
        <div className="landing-modes-detail">
          <p className="landing-section-description">From “I owe you” to “thinking of you.”<br />There’s a little TEA for every moment.</p>
          {modes.map((item, index) => <button className="landing-mode-row" key={item.name} type="button" aria-pressed={selected === index} onClick={() => setSelected(index)}><span className="landing-mode-number">0{index + 1}</span><span><strong>{item.name}</strong><span>{item.detail}</span>{selected === index && <span className="landing-mode-explanation">{item.caption}</span>}</span><span aria-hidden="true">{selected === index ? "−" : "+"}</span></button>)}
        </div>
      </section>

      <section id="how" className="landing-how">
        <div className="landing-how-title"><p className="landing-eyebrow">02 / FEELS LIKE SECOND NATURE</p><h2>Less setup.<br /><em>More living.</em></h2><p>Good technology gets out of your way.<br />Here’s what getting started feels like.</p></div>
        <ol className="landing-steps">
          <li><span>01</span><div><h3>Come as you are.</h3><p>Sign in with your email. Pick a username your people will remember.</p></div></li>
          <li><span>02</span><div><h3>Make it yours.</h3><p>Create your passkey payment account. Your device helps protect access to your money.</p></div></li>
          <li><span>03</span><div><h3>Make someone’s day.</h3><p>Add funds, choose your person, and send. Follow your payments in one activity feed.</p></div></li>
        </ol>
      </section>

      <section className="landing-security">
        <div className="landing-key-art" aria-hidden="true"><div className="landing-key-ring" /><div className="landing-key-stem" /><span>YOURS, BY DESIGN</span></div>
        <div><p className="landing-eyebrow">03 / A PERSONAL TOUCH. A PROTECTED ACCOUNT.</p><h2>Your money.<br />Your <em>signature.</em></h2><p>Your email opens the door. Your Mera passkey secures your payment account. Every onchain payment leaves a receipt you can follow.</p><div className="landing-security-tags"><span>Passkey protection</span><span>Onchain receipts</span><span>Email claim verification</span></div></div>
      </section>

      <footer className="landing-footer"><div className="landing-footer-top"><h2>Make room for<br /><em>the good stuff.</em></h2><button type="button" disabled={!online} onClick={onLogin} className="landing-primary">Find your flow <span aria-hidden="true">↗</span></button></div><div className="landing-footer-wordmark" aria-hidden="true">tea<span>✳</span></div><div className="landing-footer-bottom"><span>THE EVERYTHING APP</span><span>Currently on Monad testnet · TUSD is a test token.</span><a href="#">Back to the top ↑</a></div></footer>
    </main>
  );
}
