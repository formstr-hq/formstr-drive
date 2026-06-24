import { useState } from "react";
import { BlossomServerProvider } from "./Provider/BlossomServerProvider";
import { FileIndexProvider } from "./Provider/FileIndexProvider";
import { useProfileContext } from "./hooks/useProfileContext";
import { ProfileProvider } from "./Provider/ProfileProvider";
import { Header } from "./components/Header";
import { FolderSidebar } from "./components/FolderSidebar";
import { FileList } from "./components/FileList";
import { SharedWithMe } from "./components/SharedWithMe";
import { PublicShareView } from "./components/PublicShareView";
import { SignIn } from "./components/SignIn/SignIn";
import { useFileIndex } from "./hooks/useFileContext";
import "./App.css";

function DriveLayout() {
  const { isSignedIn, restoring } = useProfileContext();
  const { currentFolder } = useFileIndex();
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
          {currentFolder === "shared" ? <SharedWithMe /> : <FileList />}
        </main>
      </div>
    </div>
  );
}

function App() {
  const hashStr = window.location.hash;
  const isPublicShare = hashStr.includes("key=") && hashStr.includes("server=") && hashStr.includes("hash=");

  if (isPublicShare) {
    return <PublicShareView />;
  }

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
