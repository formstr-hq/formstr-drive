import {
  createContext,
  type FC,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { signerManager } from "../signer/manager";
import type { NativeSignerApp } from "../signer/types";
import { isNativePlatform } from "../utils/platform";
import type { StoredAccount } from "@formstr/signer";

interface ProfileProviderProps {
    children? : ReactNode;
}


export interface ProfileContextType {
    pubkey? : string;
    requestPubkey : (packageName?: string) => Promise<string | undefined>;
    loginWithBunkerUri: (uri: string) => Promise<string | undefined>;
    loginWithNostrConnect: (options: {
        relays: string[];
        onUri: (uri: string) => void;
        signal?: AbortSignal;
    }) => Promise<string | undefined>;
    generatePendingAccount: (passphrase: string) => { npub: string; ncryptsec: string };
    confirmPendingAccount: (ncryptsec: string, passphrase: string) => Promise<string | undefined>;
    unlockWithPassphrase: (passphrase: string) => Promise<string | undefined>;
    importNsec: (nsec: string, passphrase: string) => Promise<string | undefined>;
    logout : () => Promise<void>;
    accounts: StoredAccount[];
    switchAccount: (pubkey: string) => Promise<void>;
    removeAccount: (pubkey: string) => Promise<void>;
    isSignedIn : boolean;
    locked: boolean;
    restoring: boolean;
    nativeSignerApps: NativeSignerApp[];
    loadingNativeSignerApps: boolean;
    pendingNsecMigration: boolean;
    completeNsecMigration: (passphrase: string) => Promise<string | undefined>;
}

export interface IProfile {
    pubkey : string;
}

export const ProfileContext = createContext<ProfileContextType | undefined>(undefined);

export const ProfileProvider : FC<ProfileProviderProps> = ({ children }) => {
    const [pubkey, setPubkey] = useState<string | undefined>(undefined);
    const [locked, setLocked] = useState(false);
    const [accounts, setAccounts] = useState<StoredAccount[]>([]);
    const [pendingNsecMigration, setPendingNsecMigration] = useState(false);
    const [restoring, setRestoring] = useState(true);
    const [nativeSignerApps, setNativeSignerApps] = useState<NativeSignerApp[]>([]);
    const [loadingNativeSignerApps, setLoadingNativeSignerApps] = useState(isNativePlatform);
    const isSignedIn = !!pubkey && !locked;

    const syncFromManager = () => {
        setPubkey(signerManager.getPubkey());
        setLocked(signerManager.isLocked());
        setAccounts(signerManager.listAccounts());
        setPendingNsecMigration(signerManager.hasPendingNsecMigration());
    };

    useEffect(() => {
        const unsubscribe = signerManager.onChange(() => {
            syncFromManager();
        });

        const restoreSigner = async () => {
            try {
                await Promise.race([
                    signerManager.init(),
                    new Promise<undefined>((resolve) => {
                        setTimeout(() => resolve(undefined), 6000);
                    }),
                ]);
            } finally {
                syncFromManager();
                setRestoring(false);
            }
        };

        void restoreSigner();

        return () => {
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        if (!isNativePlatform) {
            setLoadingNativeSignerApps(false);
            return;
        }

        const loadNativeSignerApps = async () => {
            setLoadingNativeSignerApps(true);
            try {
                await signerManager.init();
                const apps = await signerManager.listAndroidSignerApps();
                setNativeSignerApps(apps);
            } catch (error) {
                console.error("Failed to load Android signer apps", error);
                setNativeSignerApps([]);
            } finally {
                setLoadingNativeSignerApps(false);
            }
        };

        void loadNativeSignerApps();
    }, []);

    const requestPubkey = async (packageName?: string) => {
        const publicKey = await signerManager.requestPubkey(packageName);
        syncFromManager();
        return publicKey;
    };

    const loginWithBunkerUri = async (uri: string) => {
        const publicKey = await signerManager.loginWithBunkerUri(uri);
        syncFromManager();
        return publicKey;
    };

    const loginWithNostrConnect = async (options: {
        relays: string[];
        onUri: (uri: string) => void;
        signal?: AbortSignal;
    }) => {
        const publicKey = await signerManager.loginWithNostrConnect(options);
        syncFromManager();
        return publicKey;
    };

    const generatePendingAccount = (passphrase: string) => {
        return signerManager.generatePendingAccount(passphrase);
    };

    const confirmPendingAccount = async (ncryptsec: string, passphrase: string) => {
        const publicKey = await signerManager.confirmPendingAccount(ncryptsec, passphrase);
        syncFromManager();
        return publicKey;
    };

    const unlockWithPassphrase = async (passphrase: string) => {
        const publicKey = await signerManager.unlockWithPassphrase(passphrase);
        syncFromManager();
        return publicKey;
    };

    const importNsec = async (nsec: string, passphrase: string) => {
        const publicKey = await signerManager.importNsec(nsec, passphrase);
        syncFromManager();
        return publicKey;
    };

    const completeNsecMigration = async (passphrase: string) => {
        const publicKey = await signerManager.completeNsecMigration(passphrase);
        syncFromManager();
        return publicKey;
    };

    const logout = async () => {
        await signerManager.logout();
        syncFromManager();
    };

    const switchAccount = async (targetPubkey: string) => {
        await signerManager.switchAccount(targetPubkey);
        syncFromManager();
    };

    const removeAccount = async (targetPubkey: string) => {
        await signerManager.removeAccount(targetPubkey);
        syncFromManager();
    };

    return (
        <ProfileContext.Provider
            value={{
                pubkey,
                requestPubkey,
                loginWithBunkerUri,
                loginWithNostrConnect,
                generatePendingAccount,
                confirmPendingAccount,
                unlockWithPassphrase,
                importNsec,
                logout,
                accounts,
                switchAccount,
                removeAccount,
                isSignedIn,
                locked,
                restoring,
                nativeSignerApps,
                loadingNativeSignerApps,
                pendingNsecMigration,
                completeNsecMigration,
            }}
        >
            {children}
        </ProfileContext.Provider>
    );
}
