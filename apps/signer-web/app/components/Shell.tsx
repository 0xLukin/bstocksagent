import Link from "next/link";
import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="nav">
        <Link href="/" className="nav-brand">
          <span className="mark" aria-hidden />
          bStocks Agent
        </Link>
      </header>
      {children}
    </div>
  );
}
