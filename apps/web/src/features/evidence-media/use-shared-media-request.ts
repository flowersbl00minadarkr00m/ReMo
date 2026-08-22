import { useEffect, useRef } from "react";

interface RequestSlot<T, TSource extends object> {
  readonly key: string;
  readonly source: TSource;
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  pending: boolean;
  consumers: number;
}

export function useSharedMediaRequest<T, TSource extends object>({ enabled, requestKey, source, request, onResolve, onReject }: {
  readonly enabled: boolean;
  readonly requestKey: string;
  readonly source?: TSource;
  readonly request: (source: TSource, signal: AbortSignal) => Promise<T>;
  readonly onResolve: (value: T) => void;
  readonly onReject: (error: unknown) => void;
}): void {
  const slotRef = useRef<RequestSlot<T, TSource>>();
  const requestRef = useRef(request);
  const resolveRef = useRef(onResolve);
  const rejectRef = useRef(onReject);
  requestRef.current = request;
  resolveRef.current = onResolve;
  rejectRef.current = onReject;

  useEffect(() => {
    if (!enabled || source === undefined) return;
    let slot = slotRef.current;
    if (slot === undefined || slot.key !== requestKey || slot.source !== source || !slot.pending || slot.controller.signal.aborted) {
      const controller = new AbortController();
      const launch = requestRef.current;
      let promise: Promise<T>;
      try {
        promise = Promise.resolve(launch(source, controller.signal));
      } catch (error) {
        promise = Promise.reject(error instanceof Error ? error : new Error("Media request failed to start."));
      }
      slot = { key: requestKey, source, controller, promise, pending: true, consumers: 0 };
      const created = slot;
      void promise.then(() => { created.pending = false; }, () => { created.pending = false; });
      slotRef.current = slot;
    }

    const consumed = slot;
    consumed.consumers += 1;
    let active = true;
    void consumed.promise.then((value) => {
      if (active && !consumed.controller.signal.aborted) resolveRef.current(value);
    }, (error: unknown) => {
      if (active && !consumed.controller.signal.aborted) rejectRef.current(error);
    });
    return () => {
      active = false;
      consumed.consumers -= 1;
      queueMicrotask(() => {
        if (consumed.consumers !== 0) return;
        if (consumed.pending) consumed.controller.abort();
        if (slotRef.current === consumed) slotRef.current = undefined;
      });
    };
  }, [enabled, requestKey, source]);
}
