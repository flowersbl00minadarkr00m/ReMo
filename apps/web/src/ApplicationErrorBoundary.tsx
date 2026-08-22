import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

interface Props { readonly children: ReactNode }
interface State { readonly hasError: boolean }

export class ApplicationErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The recovery state is intentionally visible and does not expose error details.
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return <main className="route-state application-error" role="alert" aria-labelledby="application-error-title">
      <p className="route-state-kicker">Safe application recovery</p>
      <h1 id="application-error-title">Application unavailable</h1>
      <p>The application could not render this state safely. No evidence or mutation is being claimed.</p>
      <a className="button secondary-button" href="/save-points">Open saved results</a>
    </main>;
  }
}
