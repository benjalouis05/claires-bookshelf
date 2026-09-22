import type { Metadata, Viewport } from "next";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/inter";
import "./globals.css";
import { siteConfig } from "./site-config";

export const metadata: Metadata = {
  title: siteConfig.title,
  description: siteConfig.description,
  applicationName: siteConfig.applicationName,
  category: "books",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#eee8db",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
