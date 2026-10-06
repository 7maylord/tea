import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@aurora-is-near/intents-swap-widget/styles.css";
import Pwa from "./pwa";

export const metadata: Metadata = {
  title: "TEA",
  description: "Send money like a message—even before someone joins.",
  appleWebApp: { capable: true, title: "TEA", statusBarStyle: "default" },
};

export const viewport: Viewport = { themeColor: "#f6f2e9" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col"><Pwa>{children}</Pwa></body>
    </html>
  );
}
