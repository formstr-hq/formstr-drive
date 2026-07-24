import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { SignIn } from "../SignIn/SignIn";
import { useProfileContext } from "../../hooks/useProfileContext";

interface AddAccountModalProps {
  onClose: () => void;
}

export function AddAccountModal({ onClose }: AddAccountModalProps) {
  const { accounts } = useProfileContext();
  const initialCountRef = useRef(accounts.length);

  // Every login method (extension / bunker / nostrconnect / local key /
  // native signer) funnels through the same signerManager -> onChange ->
  // syncFromManager path, so watching `accounts` grow is a single place
  // that closes the modal on success regardless of which method was used.
  useEffect(() => {
    if (accounts.length > initialCountRef.current) {
      onClose();
    }
  }, [accounts.length, onClose]);

  return createPortal(
    <div className="move-dialog-overlay" onClick={onClose}>
      <div className="add-account-modal" onClick={(e) => e.stopPropagation()}>
        <button className="add-account-modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <SignIn embedded />
      </div>
    </div>,
    document.body
  );
}
