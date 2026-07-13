import example from "../config.example";

export type PeerConfiguration = {
    CODE_PREFIX: string;
    PEER_SERVER_HOST?: string;
    PEER_SERVER_PORT?: number;
    PEER_SECURE?: boolean;
    PEER_DEBUG_LEVEL?: number;
};

const localModules = import.meta.glob("../config.local.ts", { eager: true, import: "default" });
const local = Object.values(localModules)[0] as Partial<PeerConfiguration> | undefined;

/**
 * `config.example.ts` provides safe committed defaults. A developer can copy it to
 * ignored `config.local.ts` to override only the PeerJS settings for one machine.
 */
const config: PeerConfiguration = { ...example, ...local };

export default config;
