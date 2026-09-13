import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Synixir Playground",
  description: "Explore live collaboration in the Synixir playground.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
