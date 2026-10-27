import { useEffect, useState } from "react";
import { useProfileContext } from "../../hooks/useProfileContext";
import { findOrphanedDrivePubkeys, onDriveKeysChanged } from "../../services/driveKey";
import "./DriveKeyWarningBanner.css";

/**
 * Surfaces a Drive Key this device has seen before that the current keyring
 * doesn't hold — e.g. its version sits only on a relay that hasn't answered
 * yet — instead of it silently looking like a partial drive. Only possible
 * because saveCachedDrivePubkeys keeps a union of every drive pubkey this
 * device has ever seen for the identity. Usually transient: driveKey.ts's
 * background sync merges the key back the moment a relay holding it answers,
 * and onDriveKeysChanged then clears this banner.
 */
export function DriveKeyWarningBanner() {
  const { pubkey, isSignedIn } = useProfileContext();
  const [orphaned, setOrphaned] = useState<string[]>([]);

  useEffect(() => {
    if (!isSignedIn || !pubkey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronous reset when the subscription key changes
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
    // Re-run whenever the keyring's pubkey set changes — i.e. when a sync
    // (driveKey.ts's syncDriveKeys) or an import merges the missing key in.
    // Without this the banner would only reflect the state at mount.
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
        {orphaned.length === 1 ? "" : "s"}) — files under it are hidden until it's found. Drive keeps
        checking the relays and restores it automatically.
      </span>
    </div>
  );
}
