import { useEffect, useState } from "react";
import { useProfileContext } from "../../hooks/useProfileContext";
import { findOrphanedDrivePubkeys, onDriveKeysChanged } from "../../services/driveKey";
import { DriveKeyModal } from "./DriveKeyModal";
import "./DriveKeyWarningBanner.css";

/**
 * Surfaces the drive-key-mint hazard (see driveKey.ts's restoreDriveKey doc
 * comment) the moment it's detectable, instead of it silently looking like
 * an empty or partial drive — which is exactly how it presented before this
 * existed. Only possible because saveCachedDrivePubkeys accumulates a union
 * of every drive pubkey this device has ever seen for the identity, rather
 * than overwriting: a pubkey the current keyring no longer resolves to a
 * secret for is evidence something was lost, not evidence it never existed.
 */
export function DriveKeyWarningBanner() {
  const { pubkey, isSignedIn } = useProfileContext();
  const [orphaned, setOrphaned] = useState<string[]>([]);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!isSignedIn || !pubkey) {
      setOrphaned([]);
      return;
    }

    let cancelled = false;
    const check = () => {
      findOrphanedDrivePubkeys(pubkey)
        .then((result) => {
          if (!cancelled) setOrphaned(result);
        })
        .catch(() => {
          // Inconclusive (network/signer failure) — never claim "all clear"
          // on a failed check, but also never show a false-positive warning
          // over what might just be a transient lookup failure.
        });
    };

    check();
    // Re-run whenever the keyring's pubkey set changes — either a successful
    // Import Drive Key, or refreshDriveKeyring's background top-up silently
    // finding the missing key on its own (see its doc comment: a tab that
    // already resolved a keyring otherwise never rechecks relays again).
    // Without this the banner only ever reflected the state at mount, so it
    // wouldn't clear itself even after the underlying problem was fixed.
    const unsubscribe = onDriveKeysChanged(check);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isSignedIn, pubkey]);

  if (orphaned.length === 0) return null;

  return (
    <div className="drive-key-warning-banner" role="alert">
      <span>
        A previous Drive Key for this account is missing ({orphaned.length} key
        {orphaned.length === 1 ? "" : "s"}) — files under it may be hidden until it's restored.
      </span>
      <button onClick={() => setShowModal(true)}>Import Drive Key</button>
      {showModal && <DriveKeyModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
