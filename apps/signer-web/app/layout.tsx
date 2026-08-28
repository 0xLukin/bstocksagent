import type { Metadata } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "bStocks signer",
  description: "Non-custodial: confirm BNB Chain trades with your own wallet. This page never holds the agent key.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
