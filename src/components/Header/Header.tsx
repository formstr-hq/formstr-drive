import { useFileIndex } from '../../hooks/useFileContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import FormstrLogo from "../../assets/formstr.svg";
import { ProfileMenu } from './ProfileMenu';
import { useProfileContext } from '../../hooks/useProfileContext';
import { MenuOutlined } from "@ant-design/icons";

interface HeaderProps {
  onMenuClick: () => void;
}

function Breadcrumb({
  currentFolder,
  onNavigate,
}: {
  currentFolder: string;
  onNavigate: (path: string) => void;
}) {
  const parts = currentFolder.split("/").filter(Boolean);
  let acc = "";
  const segments = parts.map((part) => {
    acc += "/" + part;
    return { name: part, path: acc };
  });

  return (
    <nav className="breadcrumb" aria-label="Folder path">
      <button
        className="breadcrumb-segment"
        onClick={() => onNavigate("/")}
        disabled={currentFolder === "/"}
      >
        My Drive
      </button>
      {segments.map((seg, i) => (
        <span key={seg.path} className="breadcrumb-item">
          <span className="breadcrumb-sep" aria-hidden="true">/</span>
          <button
            className="breadcrumb-segment"
            onClick={() => onNavigate(seg.path)}
            disabled={i === segments.length - 1}
          >
            {seg.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

export function Header({ onMenuClick }: HeaderProps) {
  const { isSignedIn, requestPubkey } = useProfileContext();
  const { currentFolder, setCurrentFolder } = useFileIndex();
  const isMobile = useIsMobile();

  return (
    <header className="app-header">
      <div className="header-left">
        {isMobile && (
            <MenuOutlined
              onClick={onMenuClick}
            />
        )}
        <img src={FormstrLogo} alt="Formstr Logo" className="app-logo" />
        <Breadcrumb currentFolder={currentFolder} onNavigate={setCurrentFolder} />
      </div>

      <div className="header-right">
        {!isSignedIn && (
          <button className="sign-in-btn" onClick={() => void requestPubkey()}>
            Connect Wallet
          </button>
        )}
        <ProfileMenu />
      </div>
    </header>
  );
}
