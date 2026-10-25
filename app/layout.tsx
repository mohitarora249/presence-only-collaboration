import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Presence Playground",
  description: "A real-time, multi-user cursor presence demo built with Next.js and Socket.IO."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
