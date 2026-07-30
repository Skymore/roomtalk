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
        <div role="alert" aria-atomic="true" className="border-b border-danger-200 bg-danger-50/95 text-danger-700 dark:border-danger-900/60 dark:bg-danger-950/75 dark:text-danger-200">
          <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-3 py-2 text-xs sm:px-5">
            <Icon icon="lucide:alert-circle" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 break-words leading-5">{error}</p>
            {setError && (
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                className="ml-auto h-9 w-9 min-w-9 flex-shrink-0 rounded-lg sm:h-8 sm:w-8 sm:min-w-8"
                onPress={() => setError(null)}
                aria-label={t("close")}
              >
                <Icon icon="lucide:x" className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      )}

      {!error && success && (
        <div role="status" aria-atomic="true" className="border-b border-success-200 bg-success-50/95 text-success-700 dark:border-success-900/60 dark:bg-success-950/75 dark:text-success-200">
          <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-3 py-2 text-xs sm:px-5">
            <Icon icon="lucide:check-circle" className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 break-words leading-5">{success}</p>
          </div>
        </div>
      )}
    </>
  );
};
