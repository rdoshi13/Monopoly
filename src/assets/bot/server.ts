import { main as startAuthority } from "../server";
import { Server } from "../sockets";

/** Bot matches use the exact same authority as human-hosted matches. */
export async function main(started?: (server: Server) => void) {
    return startAuthority(6, (_code, server) => started?.(server));
}
