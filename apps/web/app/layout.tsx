import { Toaster } from "@terabot/ui";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Terabot",
  description: "Bots with cloud computers, in a chat window.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="bg-canvas text-ink antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
