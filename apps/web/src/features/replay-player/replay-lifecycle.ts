export interface ReplayLifecycleCounters {
  readonly frames: number;
  readonly channels: number;
  readonly ports: number;
  readonly players: number;
  readonly timers: number;
  readonly listeners: number;
  readonly objectUrls: number;
}

export interface ReplayLifecycleSnapshot extends ReplayLifecycleCounters {
  readonly domNodes: number;
  readonly heapProxyResources: number;
}

type CounterName = keyof ReplayLifecycleCounters;

const EMPTY: ReplayLifecycleCounters = {
  frames: 0,
  channels: 0,
  ports: 0,
  players: 0,
  timers: 0,
  listeners: 0,
  objectUrls: 0,
};

declare global {
  interface Window {
    __REMO_REPLAY_LIFECYCLE__?: () => ReplayLifecycleSnapshot;
    __REMO_REPLAY_LIFECYCLE_COUNTERS__?: ReplayLifecycleCounters;
  }
}

function counters(): ReplayLifecycleCounters {
  window.__REMO_REPLAY_LIFECYCLE_COUNTERS__ ??= { ...EMPTY };
  window.__REMO_REPLAY_LIFECYCLE__ ??= () => {
    const current = window.__REMO_REPLAY_LIFECYCLE_COUNTERS__ ?? EMPTY;
    const domNodes = document.querySelectorAll("*").length;
    return {
      ...current,
      domNodes,
      heapProxyResources: current.frames + current.channels + current.ports + current.players + current.timers + current.listeners + current.objectUrls,
    };
  };
  return window.__REMO_REPLAY_LIFECYCLE_COUNTERS__;
}

export function adjustReplayLifecycle(counter: CounterName, delta: 1 | -1): void {
  const current = counters();
  const next = current[counter] + delta;
  if (next < 0) throw new Error(`Replay lifecycle counter ${counter} underflowed.`);
  window.__REMO_REPLAY_LIFECYCLE_COUNTERS__ = { ...current, [counter]: next };
}

export function replayLifecycleSnapshot(): ReplayLifecycleSnapshot {
  counters();
  return window.__REMO_REPLAY_LIFECYCLE__!();
}

export function installReplayLifecycleInstrumentation(): void {
  counters();
}
