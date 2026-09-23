"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export function useOnlineStatus() {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}

export default function Pwa({ children }: { children: ReactNode }) {
  const online = useOnlineStatus();
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return <>{!online && <p role="status" aria-live="polite" className="bg-amber-100 px-4 py-3 text-center text-sm font-semibold text-amber-950">You are offline. Payments are paused until you reconnect.</p>}{children}</>;
}
