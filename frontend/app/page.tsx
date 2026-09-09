import Providers from "./providers";
import TeaApp from "./tea-app";

export default function Home() {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;

  if (!appId || !apiOrigin) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 text-center">
        <span className="text-5xl font-semibold tracking-tight">tea.</span>
        <p className="mt-5 text-lg text-stone-600">Sign-in is unavailable right now.</p>
      </main>
    );
  }

  return (
    <Providers appId={appId}>
      <TeaApp apiOrigin={apiOrigin} />
    </Providers>
  );
}
