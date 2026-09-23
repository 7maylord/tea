import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TEA — The Everything App",
    short_name: "TEA",
    description: "Send money like a message—even before someone joins.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f2e9",
    theme_color: "#f6f2e9",
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
