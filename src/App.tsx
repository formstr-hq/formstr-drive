import { useEffect, useState } from "react";
import { BlossomServerProvider } from "./Provider/BlossomServerProvider";
import { FileIndexProvider } from "./Provider/FileIndexProvider";
import { useProfileContext } from "./hooks/useProfileContext";
import { ProfileProvider } from "./Provider/ProfileProvider";
import { Header } from './components/Header/Header';
import { FolderSidebar } from './components/Folders/FolderSidebar';
import { FileList } from './components/Files/FileList';
import { SharedByMeView } from './components/Shared/SharedByMeView';
import { SignIn } from "./components/SignIn/SignIn";
import { UnlockScreen } from "./components/SignIn/UnlockScreen";
import { NsecMigrationPrompt } from "./components/SignIn/NsecMigrationPrompt";
import { UploadManager } from './components/Upload/UploadManager';
import { DownloadManager } from './components/Upload/DownloadManager';
import { ToastProvider } from "./context/ToastProvider";
import { ThemeProvider } from "./context/ThemeProvider";
import { AntdThemeBridge } from "./components/ui/AntdThemeBridge";
import { SharedView } from "./components/Shared/SharedView";
import { SharesProvider } from "./context/SharesProvider";
import { parseShareHash } from "./services/sharing";
import "./App.css";

function DriveLayout() {
  const { isSignedIn, restoring, locked, pendingNsecMigration } =
    useProfileContext();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<"files" | "shared-by-me">("files");

  if (restoring) {
    return (
      <div className="loading-container">
        <div className="loading-state">Restoring session...</div>
      </div>
    );
  }

  if (pendingNsecMigration) {
    return <NsecMigrationPrompt />;
  }

  if (locked) {
    return <UnlockScreen />;
  }

  if (!isSignedIn) {
    return <SignIn />;
  }

  return (
    <div className="drive-layout">
      <Header onMenuClick={() => setSidebarOpen((prev) => !prev)} />
      <div className="drive-content">
        <FolderSidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          currentView={view}
          onSelectSharedByMe={() => setView("shared-by-me")}
          onSelectFolder={() => setView("files")}
        />
        <main className="drive-main">
          {view === "shared-by-me" ? (
            <SharedByMeView onBack={() => setView("files")} />
          ) : (
            <FileList />
          )}
        </main>
        <div className="transfer-managers-container">
          <UploadManager />
          <DownloadManager />
        </div>
      </div>
    </div>
  );
}

function App() {
  // A share link must render for anyone who opens it, signed in or not —
  // checked before the sign-in-gated provider tree even mounts, so viewing
  // one never depends on the local relay's account-scoped state or a signer
  // being available. See docs/NIP-FS.md "File/Folder Sharing".
  const [isSharedRoute, setIsSharedRoute] = useState(
    () => parseShareHash(window.location.hash) !== null,
  );

  useEffect(() => {
    const onHashChange = () => setIsSharedRoute(parseShareHash(window.location.hash) !== null);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <ThemeProvider>
      <AntdThemeBridge>
        <ToastProvider>
          {isSharedRoute ? (
            <SharedView />
          ) : (
            <ProfileProvider>
              <BlossomServerProvider>
                <FileIndexProvider>
                  <SharesProvider>
                    <DriveLayout />
                  </SharesProvider>
                </FileIndexProvider>
              </BlossomServerProvider>
            </ProfileProvider>
          )}
        </ToastProvider>
      </AntdThemeBridge>
    </ThemeProvider>
  );
}

export default App;
