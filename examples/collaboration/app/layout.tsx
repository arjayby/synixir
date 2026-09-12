import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Synixir · Work together",
  description: "A shared workspace for writing, planning, and creating together.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
