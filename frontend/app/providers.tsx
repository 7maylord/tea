"use client";

import { PrivyProvider } from "@privy-io/react-auth";
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
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        supportedChains: [monadTestnet],
        defaultChain: monadTestnet,
      }}
    >
      {children}
    </PrivyProvider>
  );
}
