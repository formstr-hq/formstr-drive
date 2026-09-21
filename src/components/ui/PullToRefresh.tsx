import { useCallback, useRef, useState, type CSSProperties, type ReactNode, type TouchEvent } from "react";
import "./PullToRefresh.css";

const PULL_THRESHOLD = 70; // px of drag before a release triggers refresh
const MAX_PULL = 100; // visual travel cap, reached via a resistance curve
const RESISTANCE = 0.5;
// Held for at least this long even if the refresh itself resolves instantly —
// refresh() only bumps a counter to re-declare the relay interest, it doesn't
// wait for new data, so without a floor the indicator would just flash.
const MIN_VISIBLE_MS = 600;

/**
 * Native-feeling pull-to-refresh: drag down from the top of `children`'s
 * scroll position to trigger `onRefresh`. Takes over the scrollable role
 * itself (apply the caller's scroll-container class via `className`) so it
 * can read `scrollTop` directly rather than needing a separate ref threaded
 * in from outside.
 *
 * Touch-only by construction — the touch handlers below never fire from a
 * mouse, so this is inert (and harmless to leave mounted) on desktop.
 */
export function PullToRefresh({
  onRefresh,
  children,
  className,
  style,
}: {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const pulling = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const reset = useCallback(() => {
    pulling.current = false;
    startY.current = null;
    setPullDistance(0);
  }, []);

  const handleTouchStart = useCallback(
    (e: TouchEvent<HTMLDivElement>) => {
      if (refreshing) return;
      const el = containerRef.current;
      if (!el || el.scrollTop > 0) return;
      startY.current = e.touches[0].clientY;
      pulling.current = true;
    },
    [refreshing],
  );

  const handleTouchMove = useCallback((e: TouchEvent<HTMLDivElement>) => {
    if (!pulling.current || startY.current === null) return;
    const el = containerRef.current;
    if (!el || el.scrollTop > 0) {
      // Scrolled away from the top mid-gesture — abandon the pull rather than
      // fighting the browser's own scroll.
      pulling.current = false;
      startY.current = null;
      setPullDistance(0);
      return;
    }

    const delta = e.touches[0].clientY - startY.current;
    if (delta <= 0) {
      setPullDistance(0);
      return;
    }

    setPullDistance(Math.min(delta * RESISTANCE, MAX_PULL));
    // Only suppress the native scroll/overscroll for this one downward-at-top
    // gesture — every other touch interaction on the page is untouched.
    e.preventDefault();
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (!pulling.current) return;
    pulling.current = false;
    startY.current = null;

    if (pullDistance < PULL_THRESHOLD) {
      setPullDistance(0);
      return;
    }

    setRefreshing(true);
    setPullDistance(PULL_THRESHOLD);
    const startedAt = Date.now();
    try {
      await onRefresh();
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_VISIBLE_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS - elapsed));
      }
      setRefreshing(false);
      setPullDistance(0);
    }
  }, [pullDistance, onRefresh]);

  const progress = Math.min(pullDistance / PULL_THRESHOLD, 1);

  return (
    <div
      ref={containerRef}
      className={`pull-to-refresh${className ? ` ${className}` : ""}`}
      style={style}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={reset}
    >
      <div
        className="pull-to-refresh-indicator-track"
        style={{ height: pullDistance, opacity: pullDistance > 0 ? 1 : 0 }}
        aria-hidden="true"
      >
        <div
          className={`pull-to-refresh-spinner${refreshing ? " pull-to-refresh-spinner--active" : ""}`}
          style={
            refreshing
              ? undefined
              : { transform: `rotate(${progress * 360}deg)`, opacity: progress }
          }
        />
      </div>
      {children}
    </div>
  );
}
