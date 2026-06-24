import { useState } from "react";
import { BlossomServerProvider } from "./Provider/BlossomServerProvider";
import { FileIndexProvider } from "./Provider/FileIndexProvider";
import { useProfileContext } from "./hooks/useProfileContext";
import { ProfileProvider } from "./Provider/ProfileProvider";
import { Header } from "./components/Header";
import { FolderSidebar } from "./components/FolderSidebar";
import { FileList } from "./components/FileList";
import { SignIn } from "./components/SignIn/SignIn";
import { UploadManager } from "./components/UploadManager";
import "./App.css";

function DriveLayout() {
  const { isSignedIn, restoring } = useProfileContext();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (restoring) {
    return (
      <div className="loading-container">
        <div className="loading-state">Restoring session...</div>
      </div>
    );
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
        />
        <main className="drive-main">
          <FileList />
        </main>
      </div>
      <UploadManager />
    </div>
  );
}

function App() {
  return (
    <ProfileProvider>
      <BlossomServerProvider>
        <FileIndexProvider>
          <DriveLayout />
        </FileIndexProvider>
      </BlossomServerProvider>
    </ProfileProvider>
  );
}

export default App;
