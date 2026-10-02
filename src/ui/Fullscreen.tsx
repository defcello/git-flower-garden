/**
 * Full screen, as video players do it: a quiet expand button in the
 * bottom-right corner; in full screen the controls and notes are hidden
 * and only the exit button remains, shown while the pointer moves or a
 * finger touches and faded out again after a few seconds. Escape (or the
 * phone's back gesture) also leaves, as the browser provides.
 */
import { useEffect, useRef, useState, type RefObject } from "react";

/** How long the exit button stays after the last movement or touch. */
export const EXIT_IDLE_MS = 2500;

/** The element in full screen is `target`; tracks entering and leaving. */
export function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const update = () => {
      setActive(
        document.fullscreenElement !== null &&
          document.fullscreenElement === target.current,
      );
    };
    document.addEventListener("fullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
    };
  }, [target]);
  const toggle = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void target.current
        ?.requestFullscreen({ navigationUI: "hide" })
        .catch(() => undefined);
    }
  };
  return { active, toggle };
}

/** Whether the browser lets a page go full screen (not iPhone Safari). */
// iPhone Safari has no fullscreenEnabled at all, though the types say so.
const supported = () =>
  typeof document !== "undefined" &&
  "fullscreenEnabled" in document &&
  document.fullscreenEnabled;

export function FullscreenButton({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  const [awake, setAwake] = useState(true);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    const sleepLater = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setAwake(false);
      }, EXIT_IDLE_MS);
    };
    const wake = () => {
      setAwake(true);
      sleepLater();
    };
    sleepLater();
    const events = ["pointermove", "pointerdown", "keydown"] as const;
    for (const e of events) document.addEventListener(e, wake);
    return () => {
      window.clearTimeout(timer.current);
      for (const e of events) document.removeEventListener(e, wake);
      // Awake again for the next time full screen is entered.
      setAwake(true);
    };
  }, [active]);

  if (!supported()) return null;
  const label = active ? "Exit full screen" : "Full screen";
  return (
    <button
      type="button"
      className={`fullscreen-button${active ? " active" : ""}${awake ? "" : " asleep"}`}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        {active ? (
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        ) : (
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        )}
      </svg>
    </button>
  );
}
