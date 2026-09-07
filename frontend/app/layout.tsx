import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TEA",
  description: "Send money like a message—even before someone joins.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
