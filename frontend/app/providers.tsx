"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import type { ReactNode } from "react";
import { foundry, monadTestnet } from "viem/chains";

export default function Providers({
  appId,
  chainId,
  children,
}: {
  appId: string;
  chainId: number;
  children: ReactNode;
}) {
  const chain = chainId === 31337 ? foundry : monadTestnet;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email'],
        appearance: { walletChainType: 'ethereum-only' },
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        supportedChains: [foundry, monadTestnet],
        defaultChain: chain,
      }}
    >
      {children}
    </PrivyProvider>
  );
}
