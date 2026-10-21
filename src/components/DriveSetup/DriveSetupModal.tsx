import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useProfileContext } from "../../hooks/useProfileContext";
import {
  getDriveKeySetupStep,
  onDriveKeySetupProgress,
  type DriveKeySetupStep,
} from "../../services/driveKey";
import "./DriveSetupModal.css";

// Don't flash the modal for a setup that finishes quickly; once shown, keep it
// long enough to read; hold the finished state briefly before leaving.
const SHOW_DELAY_MS = 600;
const MIN_VISIBLE_MS = 800;
const READY_HOLD_MS = 900;
const EXIT_MS = 200;

type Phase = "hidden" | "open" | "closing";
type KeyStep = "found" | "creating" | null;
type StepState = "pending" | "active" | "done";

/**
 * "Setting up your drive" — shown only on a device's first run for an
 * account (a new account, or an existing one on a new device), while Drive
 * looks for the Drive Key and, if there is none, creates it. A warm start
 * reports no progress at all, so returning users never see this.
 *
 * Shown at most once per sign-in, and never dismissable: it always ends on
 * its own — on "ready" it shows the finished state and leaves, on "stopped"
 * it leaves at once and FileList's degraded state (Retry, "Start a new Drive
 * Key") takes over. Later re-checks (auto-retry, Retry) don't bring it back.
 */
export function DriveSetupModal() {
  const { pubkey, isSignedIn } = useProfileContext();
  const [phase, setPhase] = useState<Phase>("hidden");
  const [keyStep, setKeyStep] = useState<KeyStep>(null);
  const [ready, setReady] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isSignedIn || !pubkey) return;

    let finished = false;
    let started = false;
    let openedAt: number | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };
    const clearTimers = () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };

    const close = (afterMs: number) => {
      finished = true;
      clearTimers();
      if (openedAt === null) return; // never shown — nothing to animate out
      later(() => {
        setPhase("closing");
        later(() => setPhase("hidden"), EXIT_MS);
      }, afterMs);
    };

    const handle = (step: DriveKeySetupStep) => {
      if (finished) return;
      switch (step) {
        case "checking":
          if (started) return; // creating re-checks once more inside its lock
          started = true;
          later(() => {
            openedAt = Date.now();
            setPhase("open");
          }, SHOW_DELAY_MS);
          return;
        case "found":
          setKeyStep((current) => current ?? "found");
          return;
        case "creating":
          setKeyStep("creating");
          return;
        case "ready": {
          setKeyStep((current) => current ?? "found");
          setReady(true);
          const shownFor = openedAt === null ? 0 : Date.now() - openedAt;
          close(Math.max(MIN_VISIBLE_MS - shownFor, 0) + READY_HOLD_MS);
          return;
        }
        case "stopped":
          close(0);
          return;
      }
    };

    const unsubscribe = onDriveKeySetupProgress(handle);
    // Setup may have begun before this mounted.
    const last = getDriveKeySetupStep();
    if (last === "checking" || last === "creating") {
      handle("checking");
      if (last === "creating") handle("creating");
    }

    return () => {
      unsubscribe();
      clearTimers();
      setPhase("hidden");
      setKeyStep(null);
      setReady(false);
    };
  }, [isSignedIn, pubkey]);

  // Move focus into the dialog while it's up, and give it back afterwards.
  useEffect(() => {
    if (phase !== "open") return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, [phase]);

  if (phase === "hidden") return null;

  const steps: Array<{ label: string; state: StepState }> = [
    { label: "Checking for your Drive Key", state: keyStep || ready ? "done" : "active" },
    {
      label:
        keyStep === "creating"
          ? "Creating your Drive Key"
          : keyStep === "found"
            ? "Found your Drive Key"
            : "Getting your Drive Key",
      state: ready || keyStep === "found" ? "done" : keyStep === "creating" ? "active" : "pending",
    },
    { label: "Your drive is ready", state: ready ? "done" : "pending" },
  ];
  const current = ready ? steps[2]! : (steps.find((s) => s.state === "active") ?? steps[0]!);

  return createPortal(
    <div className={`drive-setup-root${phase === "closing" ? " is-closing" : ""}`}>
      <div className="drive-setup-scrim" />
      <div
        ref={dialogRef}
        className={`drive-setup${ready ? " is-ready" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drive-setup-title"
        aria-describedby="drive-setup-subtitle"
        tabIndex={-1}
      >
        <div className="drive-setup-bar" aria-hidden="true" />
        <div className="drive-setup-body">
          <div className="drive-setup-intro">
            <div className="drive-setup-mark" aria-hidden="true">
              <svg viewBox="0 0 56 56" width="40" height="40" fill="none">
                <path
                  d="M8 18a5 5 0 0 1 5-5h9.6a4 4 0 0 1 2.8 1.2l2.4 2.4a4 4 0 0 0 2.8 1.2H43a5 5 0 0 1 5 5V40a5 5 0 0 1-5 5H13a5 5 0 0 1-5-5V18Z"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinejoin="round"
                />
                <circle cx="23" cy="32" r="4.5" stroke="currentColor" strokeWidth="2.4" />
                <path
                  d="M27.5 32H38M35 32v3.5M31.5 32v2.5"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <h2 id="drive-setup-title" className="drive-setup-title">
              Setting up your drive
            </h2>
            <p id="drive-setup-subtitle" className="drive-setup-subtitle">
              This only happens the first time you open Drive on a device.
            </p>
          </div>

          <ol className="drive-setup-steps">
            {steps.map((step) => (
              <li key={step.label} className={`drive-setup-step is-${step.state}`}>
                <span className="drive-setup-step-icon" aria-hidden="true">
                  {step.state === "done" && (
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="none">
                      <path
                        d="M3.5 8.5l3 3 6-7"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span>{step.label}</span>
              </li>
            ))}
          </ol>

          <p className="drive-setup-sr" aria-live="polite">
            {current.label}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
