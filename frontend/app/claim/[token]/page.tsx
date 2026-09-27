import type { Metadata } from "next";
import Providers from "../../providers";
import ClaimView from "./view";

export const metadata: Metadata = { title: "Collect money | TEA", robots: { index: false, follow: false } };

export default async function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
  if (!appId || !apiOrigin || chainId !== 10143) {
    return <main className="mx-auto max-w-md px-5 py-12">Claiming is unavailable right now.</main>;
  }
  return <Providers appId={appId}><ClaimView token={token} apiOrigin={apiOrigin} chainId={chainId} /></Providers>;
}
