export const HOSTED_DEMO_INSTALL_NOTICE = "Local installation package is on the planned roadmap. Coming to GitHub soon.";

export function HostedDemoInstallNotice() {
  return <aside className="hosted-demo-install-notice" aria-labelledby="hosted-demo-install-title">
    <p className="hosted-demo-eyebrow">Complete local-first product</p>
    <h2 id="hosted-demo-install-title">Installation availability</h2>
    <p>{HOSTED_DEMO_INSTALL_NOTICE}</p>
  </aside>;
}
