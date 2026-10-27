import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { SignIn } from "../SignIn/SignIn";
import { signerManager } from "../../signer/manager";
import { useToast } from "../../hooks/useToast";

interface AddAccountModalProps {
  onClose: () => void;
}

export function AddAccountModal({ onClose }: AddAccountModalProps) {
  const toast = useToast();
  const initialCountRef = useRef(signerManager.listAccounts().length);

  // Every login method (extension / bunker / nostrconnect / local key /
  // native signer) funnels through signerManager, which notifies on any
  // completed login. Closing on that - not on the account list growing - also
  // covers adding an account that is already on this device, which signs you
  // in to it without adding a row.
  useEffect(() => {
    const unsubscribe = signerManager.onChange(() => {
      if (signerManager.listAccounts().length <= initialCountRef.current) {
        toast.info("That account was already added - switched to it.");
      }
      onClose();
    });
    return () => {
      unsubscribe();
    };
  }, [onClose, toast]);

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
