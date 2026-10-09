/** Read-only polling. A slow request cannot overlap another tick or focus event. */
export function startLineRefresh<T>({ read, onValue, onError, visible, focusTarget, visibilityTarget, intervalMs = 15_000 }: {
  read: () => Promise<T>;
  onValue: (value: T) => void;
  onError: (error: unknown) => void;
  visible: () => boolean;
  focusTarget: EventTarget;
  visibilityTarget: EventTarget;
  intervalMs?: number;
}) {
  let stopped = false;
  let reading = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!stopped && visible()) timer = setTimeout(() => { void refresh(); }, intervalMs);
  };
  const refresh = async () => {
    if (stopped) return;
    clearTimeout(timer);
    if (!visible()) { queued = false; return; }
    if (reading) { queued = true; return; }
    reading = true;
    try {
      const value = await read();
      if (!stopped) onValue(value);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      reading = false;
      // Returning to a page can race a read of a block from before the return.
      // Coalesce those triggers into one fresh read once this one settles.
      if (queued) { queued = false; void refresh(); }
      else schedule();
    }
  };
  const resume = () => { void refresh(); };
  focusTarget.addEventListener("focus", resume);
  visibilityTarget.addEventListener("visibilitychange", resume);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    focusTarget.removeEventListener("focus", resume);
    visibilityTarget.removeEventListener("visibilitychange", resume);
  };
}
