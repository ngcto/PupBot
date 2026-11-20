import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PupBot",
  description: "Bots with cloud computers, in a chat window.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
