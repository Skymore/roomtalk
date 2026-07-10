import React from 'react';
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { Room } from "../utils/types";

interface BottomNavProps {
  view: "chat" | "rooms" | "saved" | "settings";
  setView: (view: "chat" | "rooms" | "saved" | "settings") => void;
  currentRoom: Room | null;
}

export const BottomNav: React.FC<BottomNavProps> = ({ view, setView, currentRoom }) => {
  const { t } = useTranslation();
  const activeClass = "bg-[#30302e] text-[#faf9f5] shadow-[0_0_0_1px_#30302e] dark:bg-[#faf9f5] dark:text-[#141413] dark:shadow-[0_0_0_1px_#faf9f5]";
  const inactiveClass = "text-[#5e5d59] data-[hover=true]:bg-[#e8e6dc] dark:text-[#b0aea5] dark:data-[hover=true]:bg-[#30302e]";

  return (
    <nav
      data-testid="bottom-nav"
      aria-label={t("menu")}
      className="mobile-bottom-nav z-10 flex-shrink-0 border-t border-[#dedbd0] bg-[#faf9f5]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/95 md:hidden"
    >
      <div className="flex justify-center">
        <div className="flex h-10 w-full max-w-md items-center justify-between px-4">
          <Button
            isIconOnly
            variant={view === "rooms" ? "solid" : "light"}
            color="default"
            onPress={() => setView("rooms")}
            className={`h-7 w-7 min-w-0 rounded-xl ${view === "rooms" ? activeClass : inactiveClass}`}
            aria-label={t("home")}
            aria-current={view === "rooms" ? "page" : undefined}
          >
            <Icon icon="lucide:home" className="text-base" />
          </Button>

          <Button
            isIconOnly
            variant={view === "saved" ? "solid" : "light"}
            color="default"
            onPress={() => setView("saved")}
            className={`h-7 w-7 min-w-0 rounded-xl ${view === "saved" ? activeClass : inactiveClass}`}
            aria-label={t("savedRooms")}
            aria-current={view === "saved" ? "page" : undefined}
          >
            <Icon icon="lucide:bookmark" className="text-base" />
          </Button>

          {/* 聊天按钮 - 无论是否在房间中都显示，但样式会不同 */}
          <Button
            isIconOnly
            variant={view === "chat" ? "solid" : "light"}
            color="default"
            onPress={() => currentRoom ? setView("chat") : null}
            isDisabled={!currentRoom}
            className={`h-7 w-7 min-w-0 rounded-xl ${view === "chat" ? "bg-secondary text-secondary-foreground shadow-[0_0_0_1px_hsl(var(--heroui-secondary))]" : inactiveClass}`}
            aria-label={currentRoom ? currentRoom.name : t("chatRooms")}
            aria-current={view === "chat" ? "page" : undefined}
          >
            <Icon icon="lucide:message-circle" className="text-sm" />
          </Button>

          <Button
            isIconOnly
            variant={view === "settings" ? "solid" : "light"}
            color="default"
            onPress={() => setView("settings")}
            className={`h-7 w-7 min-w-0 rounded-xl ${view === "settings" ? activeClass : inactiveClass}`}
            aria-label={t("settings")}
            aria-current={view === "settings" ? "page" : undefined}
          >
            <Icon icon="lucide:settings" className="text-base" />
          </Button>
        </div>
      </div>
    </nav>
  );
};
