import React from 'react';
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";

interface StatusMessageProps {
  error: string | null;
  success: string | null;
  setError?: (error: string | null) => void;
}

export const StatusMessage: React.FC<StatusMessageProps> = ({ error, success, setError }) => {
  const { t } = useTranslation();

  if (!error && !success) return null;

  return (
    <>
      {error && (
        <div className="bg-danger-50 border border-danger-300 p-2 text-danger">
          <div className="max-w-[1400px] mx-auto px-4 flex items-center gap-2 text-xs">
            <Icon icon="lucide:alert-circle" />
            <p>{error}</p>
            {setError && (
              <Button size="sm" variant="flat" color="danger" className="ml-auto text-xs" onPress={() => setError(null)} aria-label={t("close")}>
                {t("close")}
              </Button>
            )}
          </div>
        </div>
      )}

      {success && (
        <div className="bg-success-50 border border-success-300 p-2 text-success">
          <div className="max-w-[1400px] mx-auto px-4 flex items-center gap-2 text-xs">
            <Icon icon="lucide:check-circle" />
            <p>{success}</p>
          </div>
        </div>
      )}
    </>
  );
}; 