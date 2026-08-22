import "./ReadOnlyTransport.css";

export function ReadOnlyTransport({ position, size, canPrevious, canNext, onPrevious, onNext }: {
  readonly position: number;
  readonly size: number;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  return <nav className="history-transport" aria-label="Read-only history transport">
    <button type="button" disabled={!canPrevious} onClick={onPrevious}><span aria-hidden="true">←</span><span>Previous turn</span></button>
    <div className="transport-current" aria-live="polite"><small>Current historical view</small><strong>{position === 0 ? `No current turn · ${size} available` : `Turn ${position} of ${size}`}</strong></div>
    <button type="button" disabled={!canNext} onClick={onNext}><span>Next turn</span><span aria-hidden="true">→</span></button>
  </nav>;
}
