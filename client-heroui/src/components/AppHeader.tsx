import React from 'react';
import {
  Navbar,
  NavbarBrand,
  NavbarContent,
  Button,
  Tooltip,
  Chip,
  Avatar,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { Room } from "../utils/types";
import { getAvatarText, getAvatarColor } from "../pages/MessagePage";

interface AppHeaderProps {
  clientId: string;
  username: string;
  view: string;
  setView: (view: "chat" | "rooms" | "saved" | "settings") => void;
  currentRoom: Room | null;
  i18n: any;
  changeLanguage: (lang: string) => void;
  toggleTheme: () => void;
  isDark: boolean;
  handleCopyToClipboard: (text: string) => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  clientId,
  username,
  setView,
  view,
  i18n,
  changeLanguage,
  toggleTheme,
  isDark,
  handleCopyToClipboard
}) => {
  const { t } = useTranslation();

  return (
    <Navbar 
      isBordered 
      maxWidth="full" 
      className="bg-white/70 dark:bg-gray-900/70 backdrop-blur-md border-b border-violet-200 dark:border-gray-800 hidden md:flex"
    >
      <div className="w-full mx-auto px-2 sm:px-8 flex justify-between items-center">
        <NavbarBrand 
          className="cursor-pointer" 
          onClick={() => setView('rooms')}
        >
          <img src="/roomtalk-logo.svg" alt="RoomTalk Logo" className="w-8 h-8" />
          <p className="font-bold ml-2 bg-gradient-to-r from-violet-600 to-pink-600 bg-clip-text text-transparent text-sm">RoomTalk</p>
        </NavbarBrand>

        {/* 桌面导航按钮 (仅图标) - 移动到 Brand 右侧 */}
        <div className="hidden md:flex items-center gap-1 pl-4">
          <Tooltip content={t('home')}>
            <Button
              isIconOnly
              size="sm"
              variant={view === 'rooms' || view === 'chat' ? 'flat' : 'light'} // Home active if in rooms or chat
              color={view === 'rooms' || view === 'chat' ? 'secondary' : 'default'}
              aria-label={t('home')}
              onPress={() => setView('rooms')}
              className={` ${view === 'rooms' || view === 'chat' ? 'text-secondary-foreground' : 'text-default-600 dark:text-default-400'}`}
            >
              <Icon icon="lucide:home" width={18}/>
            </Button>
          </Tooltip>
          {/* 使用 t('savedRooms') 作为 tooltip 内容 */}
          <Tooltip content={t('savedRooms')}>
            <Button
              isIconOnly
              size="sm"
              variant={view === 'saved' ? 'flat' : 'light'}
              color={view === 'saved' ? 'secondary' : 'default'}
              aria-label={t('savedRooms')}
              onPress={() => setView('saved')}
              className={` ${view === 'saved' ? 'text-secondary-foreground' : 'text-default-600 dark:text-default-400'}`}
            >
              <Icon icon="lucide:bookmark" width={18}/>
            </Button>
          </Tooltip>
           <Tooltip content={t('settings')}>
            <Button
              isIconOnly
              size="sm"
              variant={view === 'settings' ? 'flat' : 'light'}
              color={view === 'settings' ? 'secondary' : 'default'}
              aria-label={t('settings')}
              onPress={() => setView('settings')}
              className={` ${view === 'settings' ? 'text-secondary-foreground' : 'text-default-600 dark:text-default-400'}`}
            >
              <Icon icon="lucide:settings" width={18}/>
            </Button>
          </Tooltip>
        </div>

        <NavbarContent justify="end">
          <div className="flex items-center gap-2">
            {/* 始终显示的用户ID */}
            <Tooltip content={t("yourUserId")}>
              <Chip
                variant="flat"
                color="secondary"
                size="sm"
                className="cursor-pointer text-xs"
                onClick={() => handleCopyToClipboard(clientId)}
              >
                ID: {clientId.slice(0, 8)}...
              </Chip>
            </Tooltip>

            {/* 桌面版：用户头像、语言切换和主题切换 */}
            <div className="hidden md:flex items-center gap-2">
              <Avatar name={getAvatarText(username)} color={getAvatarColor(username) as any} size="sm" />
              
              {/* 替换语言切换按钮为下拉菜单 */}
              <Dropdown>
                <DropdownTrigger>
                  <Button 
                    variant="light" 
                    className="min-w-unit-24 px-2" 
                    startContent={<Icon icon="lucide:languages" width={20} />}
                    endContent={<Icon icon="lucide:chevron-down" width={14} />}
                  >
                    {i18n.language.startsWith("zh") ? "中文" : i18n.language === "hi" ? "हिंदी" : "English"}
                  </Button>
                </DropdownTrigger>
                <DropdownMenu aria-label={t("languageSelection")}>
                  <DropdownItem key="en" onPress={() => changeLanguage("en")} startContent={<Icon icon="circle-flags:uk" />}>
                    {t("english")}
                  </DropdownItem>
                  <DropdownItem key="zh" onPress={() => changeLanguage("zh")} startContent={<Icon icon="circle-flags:cn" />}>
                    {t("chinese")}
                  </DropdownItem>
                  <DropdownItem key="hi" onPress={() => changeLanguage("hi")} startContent={<Icon icon="circle-flags:in" />}>
                    {t("hindi")}
                  </DropdownItem>
                </DropdownMenu>
              </Dropdown>
              
              <Tooltip content={isDark ? t("lightMode") : t("darkMode")}>
                <Button
                  isIconOnly
                  variant="light"
                  onPress={toggleTheme}
                  aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
                >
                  <Icon icon={isDark ? "lucide:sun" : "lucide:moon"} width={20} />
                </Button>
              </Tooltip>
            </div>

            {/* 移动版：显示头像但使用三点菜单作为下拉触发器，现在已经完全隐藏 */}
            <div className="flex md:hidden items-center gap-2">
              <Avatar name={getAvatarText(username)} color={getAvatarColor(username) as any} size="sm" />
              <Dropdown>
                <DropdownTrigger>
                  <Button isIconOnly variant="light" aria-label="Menu" className="min-w-0">
                    <Icon icon="lucide:more-vertical" width={20} />
                  </Button>
                </DropdownTrigger>
                <DropdownMenu aria-label="User actions">
                  <DropdownItem
                    key="settings"
                    startContent={<Icon icon="lucide:settings" />}
                    onPress={() => setView("settings")}
                  >
                    {t("settings")}
                  </DropdownItem>
                  
                  {/* 语言菜单 */}
                  <DropdownItem key="english" textValue={t("english")}
                    startContent={<Icon icon="circle-flags:uk" />}
                    onPress={() => changeLanguage("en")}
                  >
                    {t("english")}
                  </DropdownItem>
                  <DropdownItem key="chinese" textValue={t("chinese")}
                    startContent={<Icon icon="circle-flags:cn" />} 
                    onPress={() => changeLanguage("zh")}
                  >
                    {t("chinese")}
                  </DropdownItem>
                  <DropdownItem key="hindi" textValue={t("hindi")}
                    startContent={<Icon icon="circle-flags:in" />}
                    onPress={() => changeLanguage("hi")}
                  >
                    {t("hindi")}
                  </DropdownItem>
                  
                  <DropdownItem
                    key="theme"
                    startContent={<Icon icon={isDark ? "lucide:sun" : "lucide:moon"} />}
                    onPress={toggleTheme}
                  >
                    {isDark ? t("lightMode") : t("darkMode")}
                  </DropdownItem>
                </DropdownMenu>
              </Dropdown>
            </div>
          </div>
        </NavbarContent>
      </div>
    </Navbar>
  );
}; 