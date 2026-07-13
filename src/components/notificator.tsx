import { forwardRef, useImperativeHandle } from "react";
import { CookieManager } from "../assets/cookieManager";
import { MonopolyCookie } from "../assets/types";

export interface NotificatorRef {
    message: (message: string, type?: "info" | "warn" | "error", time?: number, after?: () => void, sfx?: boolean) => void;
}

function notificationVolume() {
    try {
        const cookie = JSON.parse(decodeURIComponent(CookieManager.get("monopolySettings") ?? "{}")) as MonopolyCookie;
        return ((cookie.settings?.audio[1] ?? 100) / 100) * ((cookie.settings?.audio[0] ?? 100) / 100);
    } catch {
        return 1;
    }
}

const NotifyElement = forwardRef<NotificatorRef>(function NotifyElement(_props, ref) {
    useImperativeHandle(ref, () => ({
        message(message, type = "info", time = 2, after, sfx = true) {
            const folder = document.querySelector("div.notify");
            if (!(folder instanceof HTMLDivElement)) return;
            const element = document.createElement("div");
            element.className = "notification";
            element.textContent = message;
            element.dataset.notifType = type;
            folder.appendChild(element);

            let hidden = false;
            const hide = () => {
                if (hidden) return;
                hidden = true;
                element.style.animation = "popoff .7s cubic-bezier(.62,.25,1,-0.73)";
                window.setTimeout(() => {
                    element.remove();
                    after?.();
                }, 700);
            };
            element.onclick = hide;
            window.setTimeout(hide, time * 1000);

            if (sfx) {
                const audio = new Audio("./notifications.mp3");
                audio.volume = notificationVolume();
                void audio.play().catch(() => undefined);
            }
        },
    }));

    return <div className="notify" />;
});

export default NotifyElement;
