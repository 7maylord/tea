"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { Toaster } from "sonner";
import type { ReactNode } from "react";
import { monadTestnet } from "viem/chains";

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
      <Toaster richColors position="top-center" />
    </PrivyProvider>
  );
}
