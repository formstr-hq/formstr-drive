import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./PullToRefresh.css";

const PULL_THRESHOLD = 70; // px of drag before a release triggers refresh
const MAX_PULL = 100; // visual travel cap
const RESISTANCE = 0.5;
const TOUCH_SLOP = 12; // px
// Held for at least this long even if the refresh resolves instantly —
// refresh() only bumps a counter to re-declare the relay interest, so without
// a floor the indicator would just flash.
const MIN_VISIBLE_MS = 600;

/**
 * Pull-to-refresh for touch devices. Takes over the scrollable role itself
 * (apply the scroll-container class via `className`) so it can read
 * `scrollTop` directly.
 *
 * Drag distance never goes through React state: touchmove writes a transform
 * straight to the indicator inside requestAnimationFrame, so pulling doesn't
 * re-render the file list on every frame. touchmove is attached natively with
 * { passive: false } because React's synthetic touch listeners are passive and
 * can't preventDefault.
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
  const indicatorRef = useRef<HTMLDivElement>(null);
  const spinnerRef = useRef<HTMLDivElement>(null);
  const onRefreshRef = useRef(onRefresh);
  const refreshingRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const el = containerRef.current;
    const indicator = indicatorRef.current;
    const spinner = spinnerRef.current;
    if (!el || !indicator || !spinner) return;

    let startX: number | null = null;
    let startY: number | null = null;
    let pulling = false;
    let distance = 0;
    let raf = 0;

    const paint = (d: number, animate: boolean) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const progress = Math.min(d / PULL_THRESHOLD, 1);
        indicator.style.transition = animate ? "transform 200ms cubic-bezier(0.2, 0, 0, 1), opacity 200ms linear" : "none";
        indicator.style.transform = `translateY(${d - 44}px)`;
        indicator.style.opacity = d > 0 ? "1" : "0";
        if (!refreshingRef.current) {
          spinner.style.transform = `rotate(${progress * 360}deg)`;
          spinner.style.opacity = String(progress);
        }
      });
    };

    const reset = () => {
      pulling = false;
      startX = null;
      startY = null;
      distance = 0;
      paint(0, true);
    };

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current || el.scrollTop > 0) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (startX === null || startY === null) return;
      if (el.scrollTop > 0) {
        // Scrolled away from the top mid-gesture: abandon the pull.
        if (pulling) reset();
        startX = startY = null;
        return;
      }
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;

      if (!pulling) {
        if (dy > TOUCH_SLOP && dy > Math.abs(dx) * 1.5) {
          pulling = true;
        } else if (Math.abs(dx) > TOUCH_SLOP || dy < -TOUCH_SLOP) {
          startX = startY = null;
          return;
        } else {
          return;
        }
      }

      distance = Math.min(Math.max(dy, 0) * RESISTANCE, MAX_PULL);
      paint(distance, false);
      if (e.cancelable) e.preventDefault();
    };

    const onEnd = async () => {
      const wasPulling = pulling;
      const d = distance;
      pulling = false;
      startX = startY = null;
      if (!wasPulling) return;

      if (d < PULL_THRESHOLD) {
        distance = 0;
        paint(0, true);
        return;
      }

      refreshingRef.current = true;
      setRefreshing(true);
      spinner.style.transform = "";
      spinner.style.opacity = "1";
      paint(PULL_THRESHOLD, true);
      const startedAt = Date.now();
      try {
        await onRefreshRef.current();
      } finally {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_VISIBLE_MS) {
          await new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS - elapsed));
        }
        refreshingRef.current = false;
        setRefreshing(false);
        distance = 0;
        paint(0, true);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", reset);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", reset);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`pull-to-refresh${className ? ` ${className}` : ""}`}
      style={style}
    >
      <div ref={indicatorRef} className="pull-to-refresh-indicator" aria-hidden="true">
        <div
          ref={spinnerRef}
          className={`pull-to-refresh-spinner${refreshing ? " pull-to-refresh-spinner--active" : ""}`}
        />
      </div>
      {children}
    </div>
  );
}
