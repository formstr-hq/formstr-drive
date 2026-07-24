import { type FC, memo } from "react";
import { Avatar } from "antd";
import { UserOutlined } from "@ant-design/icons";
import { useNostrProfile, getProfileDisplayName } from "../../hooks/useNostrProfile";

interface NostrAvatarProps {
    pubkey? : string;
}

export const NostrAvatar : FC<NostrAvatarProps> = memo(({ pubkey }) => {
    const profile = useNostrProfile(pubkey);

    // `icon` is antd's proper fallback: it renders when `src` is absent OR when
    // the image fails to load. The old code crammed the icon into `src`, so a
    // missing/broken picture (e.g. relays unreachable, no kind-0 yet) left the
    // avatar blank instead of showing the user glyph.
    return (
        <Avatar
            icon={<UserOutlined />}
            src={profile?.picture || undefined}
            style={{ background: "var(--color-accent-subtle)", color: "var(--color-accent)" }}
            alt={getProfileDisplayName(profile)}
        />
    )
});
