import { useState } from "react";
import { BlossomServerProvider } from "./Provider/BlossomServerProvider";
import { FileIndexProvider } from "./Provider/FileIndexProvider";
import { useProfileContext } from "./hooks/useProfileContext";
import { ProfileProvider } from "./Provider/ProfileProvider";
import { Header } from './components/Header/Header';
import { DriveKeyWarningBanner } from './components/Header/DriveKeyWarningBanner';
import { FolderSidebar } from './components/Folders/FolderSidebar';
import { FileList } from './components/Files/FileList';
import { SignIn } from "./components/SignIn/SignIn";
import { UnlockScreen } from "./components/SignIn/UnlockScreen";
import { NsecMigrationPrompt } from "./components/SignIn/NsecMigrationPrompt";
import { UploadManager } from './components/Upload/UploadManager';
import { DownloadManager } from './components/Upload/DownloadManager';
import { ToastProvider } from "./context/ToastProvider";
import { ThemeProvider } from "./context/ThemeProvider";
import { AntdThemeBridge } from "./components/ui/AntdThemeBridge";
import "./App.css";

function DriveLayout() {
  const { isSignedIn, restoring, locked, pendingNsecMigration } =
    useProfileContext();
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
      <DriveKeyWarningBanner />
      <div className="drive-content">
        <FolderSidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <main className="drive-main">
          <FileList />
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
  return (
    <ThemeProvider>
      <AntdThemeBridge>
        <ToastProvider>
          <ProfileProvider>
            <BlossomServerProvider>
              <FileIndexProvider>
                <DriveLayout />
              </FileIndexProvider>
            </BlossomServerProvider>
          </ProfileProvider>
        </ToastProvider>
      </AntdThemeBridge>
    </ThemeProvider>
  );
}

export default App;
