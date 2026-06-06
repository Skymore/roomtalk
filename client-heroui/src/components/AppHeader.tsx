import React from 'react';
import {
  Navbar,
  NavbarBrand,
  NavbarContent,
  Button,
  Chip,
  Avatar,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { HoverTooltip } from "./HoverTooltip";
import { useTranslation } from "react-i18next";
import { Room } from "../utils/types";
import { getAvatarText, getAvatarColor } from "../utils/userProfile";
import { getLanguageOption, languageOptions } from "../utils/languages";

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
  const currentLanguage = getLanguageOption(i18n.language);

  return (
    <Navbar
      isBordered
      maxWidth="full"
      className="flex border-b border-[#dedbd0] bg-[#faf9f5]/88 backdrop-blur-md dark:border-[#30302e] dark:bg-[#1d1d1b]/88 md:hidden"
    >
      <div className="w-full mx-auto px-2 sm:px-8 flex justify-between items-center">
        <NavbarBrand
          className="cursor-pointer"
          onClick={() => setView('rooms')}
        >
          <img src="/roomtalk-logo.svg" alt="RoomTalk Logo" className="w-8 h-8" />
          <p className="ml-2 font-serif text-base font-medium text-[#141413] dark:text-[#faf9f5]">RoomTalk</p>
        </NavbarBrand>

        {/* 桌面导航按钮 (仅图标) - 移动到 Brand 右侧 */}
        <div className="hidden md:flex items-center gap-1 pl-4">
          <HoverTooltip content={t('home')}>
            <Button
              isIconOnly
              size="sm"
              variant={view === 'rooms' || view === 'chat' ? 'flat' : 'light'} // Home active if in rooms or chat
              color={view === 'rooms' || view === 'chat' ? 'secondary' : 'default'}
              aria-label={t('home')}
              onPress={() => setView('rooms')}
              className={`rounded-xl ${view === 'rooms' || view === 'chat' ? 'bg-[#c96442] text-[#faf9f5]' : 'text-[#5e5d59] dark:text-[#b0aea5]'}`}
            >
              <Icon icon="lucide:home" width={18}/>
            </Button>
          </HoverTooltip>
          {/* 使用 t('savedRooms') 作为 tooltip 内容 */}
          <HoverTooltip content={t('savedRooms')}>
            <Button
              isIconOnly
              size="sm"
              variant={view === 'saved' ? 'flat' : 'light'}
              color={view === 'saved' ? 'secondary' : 'default'}
              aria-label={t('savedRooms')}
              onPress={() => setView('saved')}
              className={`rounded-xl ${view === 'saved' ? 'bg-[#c96442] text-[#faf9f5]' : 'text-[#5e5d59] dark:text-[#b0aea5]'}`}
            >
              <Icon icon="lucide:bookmark" width={18}/>
            </Button>
          </HoverTooltip>
           <HoverTooltip content={t('settings')}>
            <Button
              isIconOnly
              size="sm"
              variant={view === 'settings' ? 'flat' : 'light'}
              color={view === 'settings' ? 'secondary' : 'default'}
              aria-label={t('settings')}
              onPress={() => setView('settings')}
              className={`rounded-xl ${view === 'settings' ? 'bg-[#c96442] text-[#faf9f5]' : 'text-[#5e5d59] dark:text-[#b0aea5]'}`}
            >
              <Icon icon="lucide:settings" width={18}/>
            </Button>
          </HoverTooltip>
        </div>

        <NavbarContent justify="end">
          <div className="flex items-center gap-2">
            {/* 始终显示的用户ID */}
            <HoverTooltip content={t("yourUserId")}>
              <Chip
                variant="flat"
                color="secondary"
                size="sm"
                className="cursor-pointer bg-[#e8e6dc] text-xs text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]"
                onClick={() => handleCopyToClipboard(clientId)}
              >
                ID: {clientId.slice(0, 8)}...
              </Chip>
            </HoverTooltip>

            {/* 桌面版：用户头像、语言切换和主题切换 */}
            <div className="hidden md:flex items-center gap-2">
              <Avatar name={getAvatarText(username)} color={getAvatarColor(username) as any} size="sm" />

              {/* 替换语言切换按钮为下拉菜单 */}
              <Dropdown>
                <DropdownTrigger>
                  <Button
                    variant="light"
                    className="min-w-unit-24 px-2 text-[#5e5d59] dark:text-[#b0aea5]"
                    startContent={<Icon icon="lucide:languages" width={20} />}
                    endContent={<Icon icon="lucide:chevron-down" width={14} />}
                  >
                    {currentLanguage.displayName}
                  </Button>
                </DropdownTrigger>
                <DropdownMenu aria-label={t("languageSelection")}>
                  {languageOptions.map((option) => (
                    <DropdownItem
                      key={option.key}
                      textValue={t(option.labelKey)}
                      onPress={() => changeLanguage(option.key)}
                      startContent={<Icon icon={option.icon} />}
                    >
                      {t(option.labelKey)}
                    </DropdownItem>
                  ))}
                </DropdownMenu>
              </Dropdown>

              <HoverTooltip content={isDark ? t("lightMode") : t("darkMode")}>
                <Button
                  isIconOnly
                  variant="light"
                  onPress={toggleTheme}
                  aria-label={isDark ? t("switchToLightMode") : t("switchToDarkMode")}
                  className="text-[#5e5d59] dark:text-[#b0aea5]"
                >
                  <Icon icon={isDark ? "lucide:sun" : "lucide:moon"} width={20} />
                </Button>
              </HoverTooltip>
            </div>

            {/* 移动版：显示头像但使用三点菜单作为下拉触发器，现在已经完全隐藏 */}
            <div className="flex md:hidden items-center gap-2">
              <Avatar name={getAvatarText(username)} color={getAvatarColor(username) as any} size="sm" />
              <Dropdown>
                <DropdownTrigger>
                  <Button isIconOnly variant="light" aria-label={t("menu")} className="min-w-0">
                    <Icon icon="lucide:more-vertical" width={20} />
                  </Button>
                </DropdownTrigger>
                <DropdownMenu aria-label={t("userActions")}>
                  <DropdownItem
                    key="settings"
                    startContent={<Icon icon="lucide:settings" />}
                    onPress={() => setView("settings")}
                  >
                    {t("settings")}
                  </DropdownItem>

                  <DropdownItem
                    key="language-en"
                    textValue={t("english")}
                    startContent={<Icon icon="circle-flags:uk" />}
                    onPress={() => changeLanguage("en")}
                  >
                    {t("english")}
                  </DropdownItem>
                  <DropdownItem
                    key="language-zh"
                    textValue={t("chinese")}
                    startContent={<Icon icon="circle-flags:cn" />}
                    onPress={() => changeLanguage("zh")}
                  >
                    {t("chinese")}
                  </DropdownItem>
                  <DropdownItem
                    key="language-hi"
                    textValue={t("hindi")}
                    startContent={<Icon icon="circle-flags:in" />}
                    onPress={() => changeLanguage("hi")}
                  >
                    {t("hindi")}
                  </DropdownItem>
                  <DropdownItem
                    key="language-ja"
                    textValue={t("japanese")}
                    startContent={<Icon icon="circle-flags:jp" />}
                    onPress={() => changeLanguage("ja")}
                  >
                    {t("japanese")}
                  </DropdownItem>
                  <DropdownItem
                    key="language-ko"
                    textValue={t("korean")}
                    startContent={<Icon icon="circle-flags:kr" />}
                    onPress={() => changeLanguage("ko")}
                  >
                    {t("korean")}
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
