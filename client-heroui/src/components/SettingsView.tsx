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
    <div className="h-full w-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col">
        <div className="mb-8 flex items-center gap-4">
          <Avatar
            name={getAvatarText(username)}
            color={getAvatarColor(username) as any}
            size="lg"
            className="bg-[#30302e] text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]"
          />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-[#141413] dark:text-[#faf9f5]">{t("settings")}</h2>
            <p className="mt-1 truncate text-sm text-[#5e5d59] dark:text-[#b0aea5]">{t("profile")}</p>
          </div>
        </div>

        <section className="border-t border-[#dedbd0] dark:border-[#30302e]">
          <div className="flex min-h-[72px] flex-col gap-3 border-b border-[#dedbd0] py-4 dark:border-[#30302e] sm:flex-row sm:items-center">
            <div className="w-full text-sm font-medium text-[#5e5d59] dark:text-[#b0aea5] sm:w-32">
              {t("username")}
            </div>
            {showEditUsername ? (
              <div className="flex min-w-0 flex-1 gap-2">
                <Input
                  autoFocus
                  size="sm"
                  className="min-w-0 flex-1"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveUsername();
                    if (e.key === "Escape") setShowEditUsername(false);
                  }}
                />
                <div className="flex flex-shrink-0 gap-1">
                  <Button isIconOnly size="sm" color="secondary" onPress={handleSaveUsername} aria-label={t("save")}>
                    <Icon icon="lucide:check" className="text-sm" />
                  </Button>
                  <Button isIconOnly size="sm" variant="flat" onPress={() => setShowEditUsername(false)} aria-label={t("cancel")}>
                    <Icon icon="lucide:x" className="text-sm" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-[#e8e6dc] px-3 py-2 text-sm font-semibold text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]">
                  {username}
                </code>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  className="h-8 w-8 min-w-8 flex-shrink-0 text-[#c96442] dark:text-[#d97757]"
                  onPress={() => setShowEditUsername(true)}
                  aria-label={t("editUsername")}
                >
                  <Icon icon="lucide:edit" className="text-sm" />
                </Button>
              </div>
            )}
          </div>

          <div className="flex min-h-[72px] flex-col gap-3 border-b border-[#dedbd0] py-4 dark:border-[#30302e] sm:flex-row sm:items-center">
            <div className="w-full text-sm font-medium text-[#5e5d59] dark:text-[#b0aea5] sm:w-32">
              {t("userId")}
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-[#e8e6dc] px-3 py-2 text-xs text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5]">
                {clientId}
              </code>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                className="h-8 w-8 min-w-8 flex-shrink-0 text-[#c96442] dark:text-[#d97757]"
                onPress={() => handleCopyToClipboard(clientId)}
                aria-label={t("copyUserId")}
              >
                <Icon icon="lucide:copy" className="text-sm" />
              </Button>
            </div>
          </div>
        </section>

        <section className="mt-8 border-t border-[#dedbd0] dark:border-[#30302e]">
          <div className="flex min-h-[72px] flex-col gap-3 border-b border-[#dedbd0] py-4 dark:border-[#30302e] sm:flex-row sm:items-center">
            <div className="w-full text-sm font-medium text-[#5e5d59] dark:text-[#b0aea5] sm:w-32">
              {t("language")}
            </div>
            <Dropdown>
              <DropdownTrigger>
                <Button
                  variant="flat"
                  className="w-full justify-start rounded-lg bg-[#e8e6dc] text-[#4d4c48] dark:bg-[#30302e] dark:text-[#faf9f5] sm:max-w-sm"
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

          <div className="flex min-h-[72px] flex-col gap-3 border-b border-[#dedbd0] py-4 dark:border-[#30302e] sm:flex-row sm:items-center">
            <div className="w-full text-sm font-medium text-[#5e5d59] dark:text-[#b0aea5] sm:w-32">
              {t("appearance")}
            </div>
            <div className="flex w-full gap-2 sm:max-w-sm">
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
                className={`flex-1 ${isDark ? "bg-[#c96442] text-[#faf9f5]" : ""}`}
                variant={!isDark ? "flat" : "solid"}
                color="secondary"
                startContent={<Icon icon="lucide:moon" />}
                onPress={() => !isDark && setTheme("dark")}
              >
                {t("darkMode")}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
