import type { ReactNode } from "react";
import { ReMoBrand } from "../../components/brand/ReMoBrand.js";
import { HostedDemoInstallNotice } from "./HostedDemoInstallNotice.js";
import "./hosted-demo.css";

export function HostedDemoShell({ children, path }: { readonly children: ReactNode; readonly path: string }) {
  const replay = path.startsWith("/replay");
  const compare = path === "/compare";
  const history = path === "/" || path === "/save-points";
  return <div className="hosted-demo-shell">
    <header className="app-bar hosted-demo-app-bar">
      <ReMoBrand />
      <span className="product-context" aria-label="Release REL-001">/ <strong>Hosted demo</strong></span>
    </header>
    <section className="hosted-demo-boundary" aria-labelledby="hosted-demo-boundary-title">
      <div>
        <p className="hosted-demo-eyebrow">Synthetic hosted demonstration</p>
        <h1 id="hosted-demo-boundary-title">Explore Replay Rewind without connecting a repository</h1>
      </div>
      <p><strong>No real repository is connected.</strong> This deterministic fixture is simulated evidence. It cannot perform Git, filesystem, SQLite, capture, service, or persistent operations.</p>
    </section>
    <nav className="hosted-demo-navigation" aria-label="Hosted demonstration">
      <a href="/save-points" aria-current={history ? "page" : undefined}>History</a>
      <a href="/replay" aria-current={replay ? "page" : undefined}>Replay</a>
      <a href="/compare" aria-current={compare ? "page" : undefined}>Compare</a>
    </nav>
    <main className="hosted-demo-main">{children}</main>
    <HostedDemoInstallNotice />
  </div>;
}
