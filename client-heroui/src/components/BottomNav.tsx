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

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border-t border-violet-200 dark:border-gray-800 md:hidden z-10">
      <div className="flex justify-center">
        <div className="flex items-center justify-between px-3 py-1 w-full max-w-md">
          <Button
            isIconOnly
            variant={view === "rooms" ? "solid" : "light"}
            color={view === "rooms" ? "secondary" : "default"}
            onPress={() => setView("rooms")}
            className={`h-9 w-9 min-w-0 ${view === "rooms" ? "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white" : ""}`}
            aria-label={t("home")}
          >
            <Icon icon="lucide:home" className="text-lg" />
          </Button>
          
          <Button
            isIconOnly
            variant={view === "saved" ? "solid" : "light"}
            color={view === "saved" ? "secondary" : "default"}
            onPress={() => setView("saved")}
            className={`h-9 w-9 min-w-0 ${view === "saved" ? "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white" : ""}`}
            aria-label={t("savedRooms")}
          >
            <Icon icon="lucide:bookmark" className="text-lg" />
          </Button>
          
          {/* 聊天按钮 - 无论是否在房间中都显示，但样式会不同 */}
          <Button
            isIconOnly
            variant={view === "chat" ? "solid" : "light"}
            color={view === "chat" ? "secondary" : "default"}
            onPress={() => currentRoom ? setView("chat") : null}
            isDisabled={!currentRoom}
            className={`h-10 w-10 min-w-0 ${view === "chat" ? "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white" : ""}`}
            aria-label={currentRoom ? currentRoom.name : t("chatRooms")}
          >
            <Icon icon="lucide:message-circle" className="text-xl" />
          </Button>
          
          <Button
            isIconOnly
            variant={view === "settings" ? "solid" : "light"}
            color={view === "settings" ? "secondary" : "default"}
            onPress={() => setView("settings")}
            className={`h-9 w-9 min-w-0 ${view === "settings" ? "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white" : ""}`}
            aria-label={t("settings")}
          >
            <Icon icon="lucide:settings" className="text-lg" />
          </Button>
        </div>
      </div>
    </div>
  );
}; 