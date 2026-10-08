import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Synixir Playground",
  description: "Explore live collaboration in the Synixir playground.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {process.env.NODE_ENV === "production" && (
          <script
            defer
            src="https://cloud.umami.is/script.js"
            data-website-id="8c99786f-eab5-4315-981d-e942347f9ca2"
            data-exclude-search="true"
            data-exclude-hash="true"
          />
        )}
      </head>
      <body>{children}</body>
    </html>
  );
}
