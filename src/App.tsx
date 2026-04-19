import { useState } from "react";
import { BlossomServerProvider } from "./Provider/BlossomServerProvider";
import { FileIndexProvider } from "./Provider/FileIndexProvider";
import { useProfileContext } from "./hooks/useProfileContext";
import { ProfileProvider } from "./Provider/ProfileProvider";
import { Header } from "./components/Header";
import { FolderSidebar } from "./components/FolderSidebar";
import { FileList } from "./components/FileList";
import { SignIn } from "./components/SignIn/SignIn";
import { ShareAccessPage } from "./components/ShareAccessPage";
import "./App.css";

function DriveLayout() {
  const { isSignedIn } = useProfileContext();
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
    </div>
  );
}

function App() {
  const path = window.location.pathname;
  const shareMatch = path.match(/^\/share\/([^/]+)$/);

  if (shareMatch) {
    return <ShareAccessPage shareId={decodeURIComponent(shareMatch[1])} />;
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
