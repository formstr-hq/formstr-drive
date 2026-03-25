import { createContext , type FC, type ReactNode , useState } from "react";
import { setItem, LOCAL_STORAGE_KEYS, getItem } from "../utils/localStorage";

interface ProfileProviderProps {
    children? : ReactNode;
}


export interface ProfileContextType {
    pubkey? : string;
    requestPubkey : () => void;
    logout : () => void;
    isSignedIn : boolean;
}

export interface IProfile {
    pubkey : string;
}

export const ProfileContext = createContext<ProfileContextType | undefined>(undefined);

export const ProfileProvider : FC<ProfileProviderProps> = ({ children }) => {
    const [pubkey, setPubkey] = useState<string | undefined>(() => {
        const profile = getItem<IProfile>(LOCAL_STORAGE_KEYS.PROFILE);
        return profile?.pubkey ?? undefined;
      });
    const isSignedIn = !!pubkey;
    
    const requestPubkey = async () => {
        if (!window.nostr) throw new Error("NIP-07 extension not found");
        let publicKey = await window.nostr.getPublicKey();
        setPubkey(publicKey);
        setItem(LOCAL_STORAGE_KEYS.PROFILE, { pubkey: publicKey });
        return publicKey;
    }

    const logout = () => {
        setPubkey(undefined);
        setItem(LOCAL_STORAGE_KEYS.PROFILE, null);
    }

    return (
        <ProfileContext.Provider value={{ pubkey, requestPubkey , logout, isSignedIn }}>
            {children}
        </ProfileContext.Provider>
    );
}