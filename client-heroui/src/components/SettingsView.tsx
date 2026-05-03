import React from 'react';
import { Avatar, Button, Input, Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { getAvatarText, getAvatarColor } from "../utils/userProfile";
import { getLanguageOption, languageOptions } from "../utils/languages";

interface SettingsViewProps {
  clientId: string;
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
  clientId,
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
  const currentLanguage = getLanguageOption(i18n.language);

  return (
    <div className="flex h-full w-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto flex w-full max-w-md flex-col rounded-2xl border border-[#dedbd0] bg-[#faf9f5] p-6 shadow-[0_0_0_1px_rgba(194,192,182,0.35)] dark:border-[#30302e] dark:bg-[#1d1d1b]">
      {/* 头像展示 */}
      <div className="flex flex-col items-center mb-8">
        <Avatar
          name={getAvatarText(username)}
          color={getAvatarColor(username) as any}
          size="lg"
          className="bg-[#30302e] text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]"
        />
        <p className="mt-2 text-sm text-[#5e5d59] dark:text-[#b0aea5]">{t("profile")}</p>
      </div>

      {/* 资料列表 */}
      <div className="space-y-6">
        {/* 用户名行 - 内联编辑 */}
        <div className="flex items-center">
          <div className="w-24 text-[#5e5d59] dark:text-[#b0aea5]">{t("username")}:</div>
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
              <code className="flex-1 rounded bg-[#e8e6dc] px-3 py-1 text-sm font-semibold text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]">
                {username}
              </code>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                className="ml-1 h-8 w-8 min-w-0 text-[#c96442] dark:text-[#d97757]"
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
          <div className="w-24 text-[#5e5d59] dark:text-[#b0aea5]">{t("userId")}:</div>
          <code className="flex-1 overflow-hidden text-ellipsis break-all rounded bg-[#e8e6dc] px-3 py-1 text-xs text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]">
            {clientId}
          </code>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="ml-1 h-8 w-8 min-w-0 text-[#c96442] dark:text-[#d97757]"
            onPress={() => handleCopyToClipboard(clientId)}
            aria-label={t("copyUserId")}
          >
            <Icon icon="lucide:copy" className="text-sm" />
          </Button>
        </div>

        {/* 语言选择 */}
        <div className="flex items-center">
          <div className="w-24 text-[#5e5d59] dark:text-[#b0aea5]">{t("language")}:</div>
          <Dropdown>
            <DropdownTrigger>
              <Button
                variant="flat"
                className="flex-1"
                startContent={<Icon icon={currentLanguage.icon} />}
                endContent={<Icon icon="lucide:chevron-down" width={14} />}
              >
                {t(currentLanguage.labelKey)}
              </Button>
            </DropdownTrigger>
            <DropdownMenu
              aria-label={t("languageSelection")}
              onAction={(key) => changeLanguage(String(key))}
            >
              {languageOptions.map((option) => (
                <DropdownItem key={option.key} textValue={t(option.labelKey)} startContent={<Icon icon={option.icon} />}>
                  {t(option.labelKey)}
                </DropdownItem>
              ))}
            </DropdownMenu>
          </Dropdown>
        </div>

        {/* 主题选择 */}
        <div className="flex items-center">
          <div className="w-24 text-[#5e5d59] dark:text-[#b0aea5]">{t("appearance")}:</div>
          <Button
            className={`flex-1 ${!isDark ? "bg-[#c96442] text-[#faf9f5]" : ""}`}
            variant={isDark ? "flat" : "solid"}
            color="secondary"
            startContent={<Icon icon="lucide:sun" />}
            onPress={() => isDark && setTheme("light")}
          >
            {t("lightMode")}
          </Button>
          <Button
            className={`ml-2 flex-1 ${isDark ? "bg-[#c96442] text-[#faf9f5]" : ""}`}
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
    </div>
  );
};
