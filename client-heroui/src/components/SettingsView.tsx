import React from 'react';
import { Avatar, Button, Input, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { getAvatarText, getAvatarColor } from "../pages/MessagePage";

interface SettingsViewProps {
  username: string;
  setUsername: (username: string) => void;
  showEditUsername: boolean;
  setShowEditUsername: (show: boolean) => void;
  handleSaveUsername: () => void;
  handleCopyToClipboard: (text: string) => void;
  isDark: boolean;
  setTheme: (theme: string) => void;
  i18n: any;
  changeLanguage: (lang: string) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  username,
  setUsername,
  showEditUsername,
  setShowEditUsername,
  handleSaveUsername,
  handleCopyToClipboard,
  isDark,
  setTheme,
  i18n,
  changeLanguage
}) => {
  const { t } = useTranslation();
  const clientId = localStorage.getItem('clientId') || '';

  return (
    <div className="flex flex-col w-full max-w-md mx-auto p-6 h-full overflow-y-auto">
      {/* 头像展示 */}
      <div className="flex flex-col items-center mb-8">
        <Avatar 
          name={getAvatarText(username)} 
          color={getAvatarColor(username) as any} 
          size="lg"
          className="bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white"
        />
        <p className="text-sm text-default-500 mt-2">{t("profile")}</p>
      </div>

      {/* 资料列表 */}
      <div className="space-y-6">
        {/* 用户名行 - 内联编辑 */}
        <div className="flex items-center">
          <div className="w-24 text-default-500">{t("username")}:</div>
          {showEditUsername ? (
            <div className="flex-1 flex gap-2">
              <Input
                autoFocus
                size="sm"
                className="flex-1"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveUsername();
                  if (e.key === "Escape") setShowEditUsername(false);
                }}
              />
              <div className="flex gap-1">
                <Button isIconOnly size="sm" color="secondary" onPress={handleSaveUsername} aria-label={t("save")}>
                  <Icon icon="lucide:check" className="text-sm" />
                </Button>
                <Button isIconOnly size="sm" variant="flat" onPress={() => setShowEditUsername(false)} aria-label={t("cancel")}>
                  <Icon icon="lucide:x" className="text-sm" />
                </Button>
              </div>
            </div>
          ) : (
            <>
              <code className="flex-1 bg-default-100 px-3 py-1 rounded text-sm font-semibold">
                {username}
              </code>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                className="min-w-0 w-8 h-8 ml-1 text-violet-500"
                onPress={() => setShowEditUsername(true)}
                aria-label={t("editUsername")}
              >
                <Icon icon="lucide:edit" className="text-sm" />
              </Button>
            </>
          )}
        </div>

        {/* ID行 */}
        <div className="flex items-center">
          <div className="w-24 text-default-500">{t("userId")}:</div>
          <code className="flex-1 bg-default-100 px-3 py-1 rounded text-xs overflow-hidden text-ellipsis break-all">
            {clientId}
          </code>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="min-w-0 w-8 h-8 ml-1 text-violet-500"
            onPress={() => handleCopyToClipboard(clientId)}
            aria-label={t("copyUserId")}
          >
            <Icon icon="lucide:copy" className="text-sm" />
          </Button>
        </div>
        
        {/* 语言选择 */}
        <div className="flex items-center">
          <div className="w-24 text-default-500">{t("language")}:</div>
          <Dropdown>
            <DropdownTrigger>
              <Button 
                variant="flat"
                className="flex-1" 
                startContent={<Icon icon={i18n.language.startsWith("zh") ? "circle-flags:cn" : i18n.language === "hi" ? "circle-flags:in" : "circle-flags:uk"} />}
                endContent={<Icon icon="lucide:chevron-down" width={14} />}
              >
                {i18n.language.startsWith("zh") ? t("chinese") : i18n.language === "hi" ? t("hindi") : t("english")}
              </Button>
            </DropdownTrigger>
            <DropdownMenu 
              aria-label={t("languageSelection")}
              onAction={(key) => changeLanguage(key as string)}
            >
              <DropdownItem key="en" startContent={<Icon icon="circle-flags:uk" />}>
                {t("english")}
              </DropdownItem>
              <DropdownItem key="zh" startContent={<Icon icon="circle-flags:cn" />}>
                {t("chinese")}
              </DropdownItem>
              <DropdownItem key="hi" startContent={<Icon icon="circle-flags:in" />}>
                {t("hindi")}
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
        </div>
        
        {/* 主题选择 */}
        <div className="flex items-center">
          <div className="w-24 text-default-500">{t("appearance")}:</div>
          <Button 
            className="flex-1"
            variant={isDark ? "flat" : "solid"}
            color="secondary"
            startContent={<Icon icon="lucide:sun" />}
            onPress={() => isDark && setTheme("light")}
          >
            {t("lightMode")}
          </Button>
          <Button 
            className="flex-1 ml-2"
            variant={!isDark ? "flat" : "solid"}
            color="secondary"
            startContent={<Icon icon="lucide:moon" />}
            onPress={() => !isDark && setTheme("dark")}
          >
            {t("darkMode")}
          </Button>
        </div>
      </div>
    </div>
  );
}; 