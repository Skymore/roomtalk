import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';
import { Icon } from '@iconify/react';

export const LanguageSwitcher: React.FC = () => {
  const { i18n } = useTranslation();
  
  const currentLanguage = i18n.language;
  
  const toggleLanguage = () => {
    const newLanguage = currentLanguage.startsWith('zh') ? 'en' : 'zh';
    i18n.changeLanguage(newLanguage);
    console.log("Language changed to:", newLanguage);
  };

  const iconName = "lucide:languages";
  console.log("Current icon:", iconName);
  
  return (
    <Button
      isIconOnly
      variant="light"
      onPress={toggleLanguage}
      className="text-gray-700 dark:text-gray-300"
    >
      <Icon 
        icon={iconName}
        className="w-5 h-5"
      />
    </Button>
  );
}; 