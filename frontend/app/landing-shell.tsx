"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import LandingPage from "./landing-page";
import { useOnlineStatus } from "./pwa";

export default function LandingShell() {
  const online = useOnlineStatus();
  const router = useRouter();
  const { authenticated, login } = usePrivy();
  const [openingApp, setOpeningApp] = useState(false);

  useEffect(() => {
    if (openingApp && authenticated) router.push("/app");
  }, [authenticated, openingApp, router]);

  function openApp() {
    if (authenticated) {
      router.push("/app");
      return;
    }
    setOpeningApp(true);
    login();
  }

  return <LandingPage online={online} onLogin={openApp} />;
}
