import Providers from "./providers";
import LandingShell from "./landing-shell";

export default function Home() {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 text-center">
        <span className="text-5xl font-semibold tracking-tight">tea.</span>
        <p className="mt-5 text-lg text-stone-600">Sign-in is unavailable right now.</p>
      </main>
    );
  }

  return (
    <Providers appId={appId}>
      <LandingShell />
    </Providers>
  );
}
