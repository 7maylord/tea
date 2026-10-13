"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { Toaster } from "sonner";
import type { ReactNode } from "react";
import { monadTestnet } from "./monad";

export default function Providers({
  appId,
  children,
}: {
  appId: string;
  children: ReactNode;
}) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email'],
        appearance: { walletChainType: 'ethereum-only' },
        supportedChains: [monadTestnet],
        defaultChain: monadTestnet,
      }}
    >
      {children}
      <Toaster closeButton richColors position="top-center" toastOptions={{ duration: 4500 }} />
    </PrivyProvider>
  );
}
