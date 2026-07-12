import { type FC , useState , useEffect, memo } from "react";
import { Avatar } from "antd";
import { UserOutlined } from "@ant-design/icons";
import { dataLayer, type Event } from "@formstr/local-relay";

interface NostrAvatarProps {
    pubkey? : string;
}

interface Profile {
    name? : string;
    picture? : string;
}

export const NostrAvatar : FC<NostrAvatarProps> = memo(({ pubkey }) => {
    const [profile , setProfile] = useState<Profile | undefined>(undefined);

    useEffect(() => {
        if(!pubkey) return;

        // Standing kind-0 interest: the cached profile renders instantly on
        // repeat loads and live updates replace it if a newer one arrives.
        let newest = 0;
        const handle = dataLayer.observe(
            [{ kinds: [0], authors: [pubkey], limit: 1 }],
            {
                onEvent: (event: Event) => {
                    if (event.created_at <= newest) return;
                    newest = event.created_at;
                    try {
                        setProfile(JSON.parse(event.content));
                    } catch {
                        // Ignore malformed profile content
                    }
                },
            },
        );

        return () => {
            handle.unobserve();
        };
    },[pubkey]);

    return (
        <Avatar
            src={profile?.picture || <UserOutlined style={{ color : "black" }} />}
            alt={profile?.name}
        />
    )
});
