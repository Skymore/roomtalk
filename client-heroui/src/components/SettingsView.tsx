import React from 'react';
import {
  Avatar,
  Button,
  Input,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Chip,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { getAvatarText, getAvatarColor } from "../utils/userProfile";
import { getLanguageOption, languageOptions } from "../utils/languages";
import { FeatureIntro } from "./FeatureIntro";
import {
  ClientAccountStatus,
  ClientAuthStatus,
  getClientAccountStatus,
  getClientAuthStatus,
  loginWithClientPassword,
  loginWithGoogleCredential,
  setClientPassword,
} from "../utils/socket";
import {
  disablePushNotifications,
  enablePushNotifications,
  getPushNotificationStatus,
  PushNotificationStatus,
} from "../utils/pushNotifications";
import {
  CodexConnectionStatus,
  CodexDeviceAuthInfo,
  cancelCodexDeviceAuth,
  disconnectCodexConnection,
  getCodexConnectionStatus,
  startCodexDeviceAuth,
} from "../utils/codexConnection";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim();
const GOOGLE_BUTTON_MAX_WIDTH = 320;
const GOOGLE_BUTTON_DARK_FRAME_GUTTER = 10;
const GOOGLE_BUTTON_DARK_FRAME_HEIGHT = 44;

type GoogleCredentialResponse = {
  credential?: string;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (options: {
            client_id: string;
            callback: (response: GoogleCredentialResponse) => void;
            color_scheme?: 'default' | 'light' | 'dark';
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

let googleIdentityScriptPromise: Promise<void> | null = null;

const loadGoogleIdentityScript = () => {
  if (googleIdentityScriptPromise) {
    return googleIdentityScriptPromise;
  }

  googleIdentityScriptPromise = new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Failed to load Google sign-in')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google sign-in'));
    document.head.appendChild(script);
  });

  return googleIdentityScriptPromise;
};

const getGoogleButtonWidth = (buttonContainer: HTMLElement) => {
  const containerWidth = Math.floor(buttonContainer.getBoundingClientRect().width);
  return Math.min(GOOGLE_BUTTON_MAX_WIDTH, containerWidth || GOOGLE_BUTTON_MAX_WIDTH);
};

const tightenGoogleButtonDarkFrame = (buttonContainer: HTMLElement, buttonWidth: number) => {
  const iframe = buttonContainer.querySelector<HTMLIFrameElement>('iframe');
  if (!iframe) {
    return false;
  }

  iframe.style.height = `${GOOGLE_BUTTON_DARK_FRAME_HEIGHT}px`;
  iframe.style.margin = '-2px 0 0 -10px';
  iframe.style.maxWidth = 'none';
  iframe.style.width = `${buttonWidth + GOOGLE_BUTTON_DARK_FRAME_GUTTER * 2}px`;

  return true;
};

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
  isCodexConnectionsEnabled?: boolean;
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
  changeLanguage,
  isCodexConnectionsEnabled = false
}) => {
  const { t } = useTranslation();
  const currentLanguage = getLanguageOption(i18n.language);
  const [pushStatus, setPushStatus] = React.useState<PushNotificationStatus>('unsupported');
  const [pushError, setPushError] = React.useState('');
  const [isUpdatingPush, setIsUpdatingPush] = React.useState(false);
  const [clientAuthStatus, setClientAuthStatus] = React.useState<ClientAuthStatus | null>(null);
  const [isUpdatingClientAuth, setIsUpdatingClientAuth] = React.useState(false);
  const [clientAuthError, setClientAuthError] = React.useState('');
  const [clientAuthMessage, setClientAuthMessage] = React.useState('');
  const [currentClientPassword, setCurrentClientPassword] = React.useState('');
  const [newClientPassword, setNewClientPassword] = React.useState('');
  const [loginClientId, setLoginClientId] = React.useState('');
  const [loginPassword, setLoginPassword] = React.useState('');
  const [accountStatus, setAccountStatus] = React.useState<ClientAccountStatus | null>(null);
  const [isUpdatingGoogleAuth, setIsUpdatingGoogleAuth] = React.useState(false);
  const [googleAuthError, setGoogleAuthError] = React.useState('');
  const [googleAuthMessage, setGoogleAuthMessage] = React.useState('');
  const googleButtonRef = React.useRef<HTMLDivElement | null>(null);
  const [codexStatus, setCodexStatus] = React.useState<CodexConnectionStatus | null>(null);
  const [codexDeviceAuth, setCodexDeviceAuth] = React.useState<CodexDeviceAuthInfo | null>(null);
  const [isLoadingCodexStatus, setIsLoadingCodexStatus] = React.useState(false);
  const [isUpdatingCodex, setIsUpdatingCodex] = React.useState(false);
  const [codexError, setCodexError] = React.useState('');
  const [codexMessage, setCodexMessage] = React.useState('');
  const [isCodexLoginModalOpen, setIsCodexLoginModalOpen] = React.useState(false);
  const [codexDeviceAuthSecondsRemaining, setCodexDeviceAuthSecondsRemaining] = React.useState<number | null>(null);

  const refreshPushStatus = React.useCallback(async () => {
    try {
      setPushStatus(await getPushNotificationStatus());
      setPushError('');
    } catch (error) {
      setPushStatus('server-disabled');
      setPushError(error instanceof Error ? error.message : t('notificationUnknownError'));
    }
  }, [t]);

  React.useEffect(() => {
    void refreshPushStatus();
  }, [refreshPushStatus]);

  const refreshClientAuthStatus = React.useCallback(async () => {
    try {
      setClientAuthStatus(await getClientAuthStatus(clientId));
      setClientAuthError('');
    } catch (error) {
      setClientAuthError(error instanceof Error ? error.message : t('userIdLoginUnknownError'));
    }
  }, [clientId, t]);

  React.useEffect(() => {
    void refreshClientAuthStatus();
  }, [refreshClientAuthStatus]);

  const refreshAccountStatus = React.useCallback(async () => {
    try {
      const status = await getClientAccountStatus(clientId);
      setAccountStatus(status);
      setGoogleAuthError('');
    } catch (error) {
      setGoogleAuthError(error instanceof Error ? error.message : t('googleSignInUnknownError'));
    }
  }, [clientId, t]);

  React.useEffect(() => {
    void refreshAccountStatus();
  }, [refreshAccountStatus]);

  const refreshCodexStatus = React.useCallback(async (options: { silent?: boolean } = {}) => {
    if (!isCodexConnectionsEnabled) {
      setCodexStatus(null);
      setCodexDeviceAuth(null);
      return;
    }
    if (!options.silent) {
      setIsLoadingCodexStatus(true);
    }
    try {
      const status = await getCodexConnectionStatus(clientId);
      setCodexStatus(status);
      if (status.status === 'connected' || status.status === 'disconnected' || status.status === 'reauth_required') {
        setCodexDeviceAuth(null);
        setIsCodexLoginModalOpen(false);
      }
      setCodexError('');
    } catch (error) {
      setCodexError(error instanceof Error ? error.message : t('codexConnectionUnknownError'));
    } finally {
      if (!options.silent) {
        setIsLoadingCodexStatus(false);
      }
    }
  }, [clientId, isCodexConnectionsEnabled, t]);

  React.useEffect(() => {
    void refreshCodexStatus();
  }, [refreshCodexStatus]);

  React.useEffect(() => {
    if (!isCodexConnectionsEnabled || (!codexDeviceAuth && codexStatus?.status !== 'pending')) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshCodexStatus({ silent: true });
    }, 2500);
    return () => window.clearInterval(interval);
  }, [codexDeviceAuth, codexStatus?.status, isCodexConnectionsEnabled, refreshCodexStatus]);

  React.useEffect(() => {
    if (!codexDeviceAuth?.expiresAt) {
      setCodexDeviceAuthSecondsRemaining(null);
      return;
    }
    const expiresAtMs = Date.parse(codexDeviceAuth.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      setCodexDeviceAuthSecondsRemaining(null);
      return;
    }
    const update = () => {
      setCodexDeviceAuthSecondsRemaining(Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000)));
    };
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [codexDeviceAuth?.expiresAt]);

  const handleEnablePush = React.useCallback(async () => {
    setIsUpdatingPush(true);
    setPushError('');
    try {
      await enablePushNotifications();
      await refreshPushStatus();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : t('notificationUnknownError'));
      await refreshPushStatus();
    } finally {
      setIsUpdatingPush(false);
    }
  }, [refreshPushStatus, t]);

  const handleDisablePush = async () => {
    setIsUpdatingPush(true);
    setPushError('');
    try {
      await disablePushNotifications();
      await refreshPushStatus();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : t('notificationUnknownError'));
    } finally {
      setIsUpdatingPush(false);
    }
  };

  const handleSetClientPassword = async () => {
    setClientAuthError('');
    setClientAuthMessage('');
    if (newClientPassword.length < 8 || newClientPassword.length > 128) {
      setClientAuthError(t('userIdPasswordLengthError'));
      return;
    }

    setIsUpdatingClientAuth(true);
    try {
      const status = await setClientPassword(newClientPassword, currentClientPassword || undefined);
      setClientAuthStatus(status);
      setCurrentClientPassword('');
      setNewClientPassword('');
      setClientAuthMessage(t('userIdPasswordSaved'));
    } catch (error) {
      setClientAuthError(error instanceof Error ? error.message : t('userIdLoginUnknownError'));
    } finally {
      setIsUpdatingClientAuth(false);
    }
  };

  const handleLoginExistingClientId = async () => {
    setClientAuthError('');
    setClientAuthMessage('');
    if (!loginClientId.trim() || !loginPassword) {
      setClientAuthError(t('userIdLoginRequiredError'));
      return;
    }

    setIsUpdatingClientAuth(true);
    try {
      await loginWithClientPassword(loginClientId.trim(), loginPassword);
      setClientAuthMessage(t('userIdLoginSuccess'));
      window.setTimeout(() => window.location.reload(), 100);
    } catch (error) {
      setClientAuthError(error instanceof Error ? error.message : t('userIdLoginUnknownError'));
    } finally {
      setIsUpdatingClientAuth(false);
    }
  };

  const handleStartCodexConnection = async () => {
    setCodexError('');
    setCodexMessage('');
    setIsUpdatingCodex(true);
    try {
      const started = await startCodexDeviceAuth(clientId);
      setCodexDeviceAuth(started.deviceAuth);
      setCodexStatus({
        clientId: started.clientId,
        provider: 'codex',
        status: 'pending',
        authVersion: codexStatus?.authVersion || 0,
        createdAt: codexStatus?.createdAt || '',
        updatedAt: new Date().toISOString(),
        locked: false,
      });
      setCodexMessage(t('codexConnectionStarted'));
      setIsCodexLoginModalOpen(true);
      window.open(started.deviceAuth.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setCodexError(error instanceof Error ? error.message : t('codexConnectionUnknownError'));
      await refreshCodexStatus({ silent: true });
    } finally {
      setIsUpdatingCodex(false);
    }
  };

  const handleCancelCodexDeviceAuth = async () => {
    setCodexError('');
    setCodexMessage('');
    setIsUpdatingCodex(true);
    try {
      const result = await cancelCodexDeviceAuth(clientId);
      setCodexStatus(result.status);
      setCodexDeviceAuth(null);
      setIsCodexLoginModalOpen(false);
      setCodexMessage(result.cancelled ? t('codexConnectionCancelled') : t('codexConnectionDisconnected'));
    } catch (error) {
      setCodexError(error instanceof Error ? error.message : t('codexConnectionUnknownError'));
    } finally {
      setIsUpdatingCodex(false);
    }
  };

  const handleCloseCodexLoginModal = () => {
    if (codexDeviceAuth && codexStatus?.status === 'pending') {
      void handleCancelCodexDeviceAuth();
      return;
    }
    setIsCodexLoginModalOpen(false);
  };

  const handleDisconnectCodex = async () => {
    setCodexError('');
    setCodexMessage('');
    setIsUpdatingCodex(true);
    try {
      const status = await disconnectCodexConnection(clientId);
      setCodexStatus(status);
      setCodexDeviceAuth(null);
      setCodexMessage(t('codexConnectionDisconnected'));
    } catch (error) {
      setCodexError(error instanceof Error ? error.message : t('codexConnectionUnknownError'));
    } finally {
      setIsUpdatingCodex(false);
    }
  };

  const handleCopyCodexDeviceCode = () => {
    if (!codexDeviceAuth?.code) {
      return;
    }
    handleCopyToClipboard(codexDeviceAuth.code);
    setCodexMessage(t('codexDeviceCodeCopied'));
  };

  const handleGoogleCredential = React.useCallback(async (response: GoogleCredentialResponse) => {
    setGoogleAuthError('');
    setGoogleAuthMessage('');
    const credential = typeof response.credential === 'string' ? response.credential : '';
    if (!credential) {
      setGoogleAuthError(t('googleSignInUnknownError'));
      return;
    }

    const shouldRefreshPush = pushStatus === 'subscribed';
    setIsUpdatingGoogleAuth(true);
    try {
      const result = await loginWithGoogleCredential(credential);
      setAccountStatus({
        clientId: result.clientId,
        hasPassword: result.hasPassword,
        googleConfigured: true,
        account: result.account,
      });
      setClientAuthStatus({
        clientId: result.clientId,
        hasPassword: result.hasPassword,
        hasAccount: true,
      });
      setGoogleAuthMessage(t('googleSignInSuccess'));
      if (shouldRefreshPush) {
        await enablePushNotifications().catch((error) => {
          console.warn('Failed to refresh push subscription after Google sign-in:', error);
        });
      }
      window.setTimeout(() => window.location.reload(), 150);
    } catch (error) {
      setGoogleAuthError(error instanceof Error ? error.message : t('googleSignInUnknownError'));
    } finally {
      setIsUpdatingGoogleAuth(false);
    }
  }, [pushStatus, t]);

  const isGoogleLoginAvailable = Boolean(GOOGLE_CLIENT_ID) && Boolean(accountStatus?.googleConfigured);
  const shouldRenderGoogleButton = isGoogleLoginAvailable && !accountStatus?.account;

  React.useEffect(() => {
    const buttonContainer = googleButtonRef.current;
    if (!shouldRenderGoogleButton || !buttonContainer || !GOOGLE_CLIENT_ID) {
      buttonContainer?.replaceChildren();
      return;
    }

    let cancelled = false;
    let buttonFrameObserver: MutationObserver | null = null;
    let animationFrame = 0;
    buttonContainer.replaceChildren();
    loadGoogleIdentityScript()
      .then(() => {
        if (cancelled || !window.google?.accounts?.id || !googleButtonRef.current) {
          return;
        }
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleGoogleCredential,
          color_scheme: isDark ? 'dark' : 'light',
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        googleButtonRef.current.replaceChildren();
        const buttonWidth = getGoogleButtonWidth(googleButtonRef.current);
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          type: 'standard',
          theme: isDark ? 'filled_black' : 'outline',
          size: 'large',
          shape: 'rectangular',
          text: 'signin_with',
          logo_alignment: 'left',
          width: buttonWidth,
        });
        if (isDark) {
          const tightenFrame = () => {
            if (googleButtonRef.current) {
              const didTightenFrame = tightenGoogleButtonDarkFrame(googleButtonRef.current, buttonWidth);
              if (didTightenFrame) {
                buttonFrameObserver?.disconnect();
              }
            }
          };

          if (typeof MutationObserver !== 'undefined') {
            buttonFrameObserver = new MutationObserver(tightenFrame);
            buttonFrameObserver.observe(googleButtonRef.current, { childList: true, subtree: true });
          }

          animationFrame = window.requestAnimationFrame(tightenFrame);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setGoogleAuthError(error instanceof Error ? error.message : t('googleSignInUnknownError'));
        }
      });

    return () => {
      cancelled = true;
      buttonFrameObserver?.disconnect();
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      buttonContainer.replaceChildren();
    };
  }, [handleGoogleCredential, isDark, shouldRenderGoogleButton, t]);

  const pushStatusLabel = React.useMemo(() => {
    if (pushStatus === 'subscribed') return t('notificationStatusOn');
    if (pushStatus === 'ios-install-required') return t('notificationStatusInstallRequired');
    if (pushStatus === 'denied') return t('notificationStatusDenied');
    if (pushStatus === 'unsupported') return t('notificationStatusUnsupported');
    if (pushStatus === 'server-disabled') return t('notificationStatusServerDisabled');
    return t('notificationStatusOff');
  }, [pushStatus, t]);

  const notificationIntro = React.useMemo(() => {
    if (pushStatus === 'ios-install-required') {
      return {
        featureKey: 'push-notifications-ios-install',
        title: t('notificationInstallIntroTitle'),
        description: t('notificationInstallIntroDescription'),
      };
    }

    if (pushStatus === 'default' || pushStatus === 'unsubscribed') {
      return {
        featureKey: 'push-notifications',
        title: t('notificationIntroTitle'),
        description: t('notificationIntroDescription'),
        actionLabel: t('enableNotifications'),
        onAction: handleEnablePush,
        actionIcon: 'lucide:bell',
      };
    }

    return null;
  }, [handleEnablePush, pushStatus, t]);

  const codexStatusLabel = React.useMemo(() => {
    if (codexStatus?.status === 'connected') return t('codexConnectionStatusConnected');
    if (codexStatus?.status === 'pending') return t('codexConnectionStatusConnecting');
    if (codexStatus?.status === 'reauth_required') return t('codexConnectionStatusReauthRequired');
    return t('codexConnectionStatusDisconnected');
  }, [codexStatus?.status, t]);

  const codexStatusColor = codexStatus?.status === 'connected'
    ? 'success'
    : codexStatus?.status === 'pending'
      ? 'warning'
      : codexStatus?.status === 'reauth_required'
        ? 'danger'
        : 'default';
  const codexExpiryLabel = React.useMemo(() => {
    if (codexDeviceAuthSecondsRemaining === null) {
      return '';
    }
    if (codexDeviceAuthSecondsRemaining <= 0) {
      return t('codexDeviceCodeExpired');
    }
    return t('codexDeviceCodeExpiresIn', { time: formatCountdown(codexDeviceAuthSecondsRemaining) });
  }, [codexDeviceAuthSecondsRemaining, t]);

  return (
    <>
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

          <div className="flex min-h-[72px] flex-col gap-3 border-b border-[#dedbd0] py-4 dark:border-[#30302e] sm:flex-row">
            <div className="w-full pt-1 text-sm font-medium text-[#5e5d59] dark:text-[#b0aea5] sm:w-32">
              {t("googleAccount")}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:max-w-sm">
              <FeatureIntro
                featureKey="google-account-login"
                title={t("googleAccountIntroTitle")}
                description={t("googleAccountIntroDescription")}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Chip
                  size="sm"
                  variant="flat"
                  color={accountStatus?.account ? 'success' : 'default'}
                >
                  {accountStatus?.account ? t("googleAccountLinked") : t("googleAccountNotLinked")}
                </Chip>
                {accountStatus?.account && (
                  <Chip
                    size="sm"
                    variant="flat"
                    color={accountStatus.account.emailVerified ? 'success' : 'warning'}
                  >
                    {accountStatus.account.emailVerified ? t("googleEmailVerified") : t("googleEmailUnverified")}
                  </Chip>
                )}
              </div>
              {accountStatus?.account && (
                <div className="flex min-w-0 items-center gap-3 rounded-lg bg-[#e8e6dc] p-3 dark:bg-[#242423]">
                  <Avatar
                    size="sm"
                    src={accountStatus.account.avatarUrl}
                    name={accountStatus.account.displayName || accountStatus.account.email || "G"}
                    className="flex-shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#141413] dark:text-[#faf9f5]">
                      {accountStatus.account.displayName || accountStatus.account.email || "Google"}
                    </p>
                    {accountStatus.account.email && (
                      <p className="truncate text-xs text-[#77756f] dark:text-[#b0aea5]">{accountStatus.account.email}</p>
                    )}
                  </div>
                </div>
              )}
              {shouldRenderGoogleButton && (
                <div
                  ref={googleButtonRef}
                  className={[
                    'w-full max-w-[320px]',
                    isDark ? 'h-10 overflow-hidden rounded-md bg-[#1d1d1b]' : 'min-h-10',
                    isUpdatingGoogleAuth ? 'pointer-events-none opacity-60' : '',
                  ].join(' ')}
                />
              )}
              {accountStatus && !isGoogleLoginAvailable && !accountStatus.account && (
                <p className="text-xs leading-5 text-[#77756f] dark:text-[#b0aea5]">{t("googleAccountUnavailable")}</p>
              )}
              {isUpdatingGoogleAuth && (
                <p className="text-xs leading-5 text-[#77756f] dark:text-[#b0aea5]">{t("googleSignInInProgress")}</p>
              )}
              {googleAuthMessage && (
                <p className="text-xs leading-5 text-[#2f7d4f] dark:text-[#7ed9a3]">{googleAuthMessage}</p>
              )}
              {googleAuthError && (
                <p className="text-xs leading-5 text-[#b54832] dark:text-[#ff8b6e]">{googleAuthError}</p>
              )}
            </div>
          </div>

          <div className="flex min-h-[72px] flex-col gap-3 py-4 sm:flex-row">
            <div className="w-full pt-1 text-sm font-medium text-[#5e5d59] dark:text-[#b0aea5] sm:w-32">
              {t("userIdLogin")}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:max-w-sm">
              <FeatureIntro
                featureKey="user-id-password-login"
                title={t("userIdLoginIntroTitle")}
                description={t("userIdLoginIntroDescription")}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Chip
                  size="sm"
                  variant="flat"
                  color={clientAuthStatus?.hasPassword ? 'success' : 'default'}
                >
                  {clientAuthStatus?.hasPassword ? t("userIdPasswordEnabled") : t("userIdPasswordNotSet")}
                </Chip>
              </div>
              <div className="grid gap-2">
                {clientAuthStatus?.hasPassword && (
                  <Input
                    size="sm"
                    type="password"
                    label={t("currentUserIdPassword")}
                    value={currentClientPassword}
                    onChange={(event) => setCurrentClientPassword(event.target.value)}
                    autoComplete="current-password"
                  />
                )}
                <Input
                  size="sm"
                  type="password"
                  label={clientAuthStatus?.hasPassword ? t("newUserIdPassword") : t("userIdPassword")}
                  value={newClientPassword}
                  onChange={(event) => setNewClientPassword(event.target.value)}
                  autoComplete="new-password"
                />
                <Button
                  size="sm"
                  color="secondary"
                  className="justify-self-start bg-[#c96442] text-[#faf9f5]"
                  isLoading={isUpdatingClientAuth}
                  startContent={!isUpdatingClientAuth ? <Icon icon="lucide:key-round" /> : undefined}
                  onPress={handleSetClientPassword}
                >
                  {clientAuthStatus?.hasPassword ? t("changeUserIdPassword") : t("setUserIdPassword")}
                </Button>
              </div>
              <div className="grid gap-2 border-t border-[#dedbd0] pt-3 dark:border-[#30302e]">
                <p className="text-xs leading-5 text-[#77756f] dark:text-[#b0aea5]">
                  {t("userIdLoginHelp")}
                </p>
                <Input
                  size="sm"
                  label={t("existingUserId")}
                  value={loginClientId}
                  onChange={(event) => setLoginClientId(event.target.value)}
                  autoComplete="username"
                />
                <Input
                  size="sm"
                  type="password"
                  label={t("userIdPassword")}
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  autoComplete="current-password"
                />
                <Button
                  size="sm"
                  variant="flat"
                  className="justify-self-start"
                  isLoading={isUpdatingClientAuth}
                  startContent={!isUpdatingClientAuth ? <Icon icon="lucide:log-in" /> : undefined}
                  onPress={handleLoginExistingClientId}
                >
                  {t("useExistingUserId")}
                </Button>
              </div>
              {clientAuthMessage && (
                <p className="text-xs leading-5 text-[#2f7d4f] dark:text-[#7ed9a3]">{clientAuthMessage}</p>
              )}
              {clientAuthError && (
                <p className="text-xs leading-5 text-[#b54832] dark:text-[#ff8b6e]">{clientAuthError}</p>
              )}
            </div>
          </div>
        </section>

        {isCodexConnectionsEnabled && (
          <section className="mt-8 border-t border-[#dedbd0] dark:border-[#30302e]">
            <div className="flex min-h-[72px] flex-col gap-3 py-4 sm:flex-row">
              <div className="w-full pt-1 text-sm font-medium text-[#5e5d59] dark:text-[#b0aea5] sm:w-32">
                {t("codexConnection")}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3 sm:max-w-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip size="sm" variant="flat" color={codexStatusColor}>
                    {codexStatusLabel}
                  </Chip>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="flat"
                    className="h-8 w-8 min-w-8"
                    isLoading={isLoadingCodexStatus}
                    onPress={() => refreshCodexStatus()}
                    aria-label={t("refreshCodexConnection")}
                  >
                    <Icon icon="lucide:refresh-cw" className="text-sm" />
                  </Button>
                  {codexStatus?.status === 'connected' ? (
                    <Button
                      size="sm"
                      variant="flat"
                      isLoading={isUpdatingCodex}
                      startContent={!isUpdatingCodex ? <Icon icon="lucide:unlink" /> : undefined}
                      onPress={handleDisconnectCodex}
                    >
                      {t("disconnectCodex")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      color="secondary"
                      className="bg-[#c96442] text-[#faf9f5]"
                      isLoading={isUpdatingCodex}
                      startContent={!isUpdatingCodex ? <Icon icon="lucide:terminal" /> : undefined}
                      onPress={handleStartCodexConnection}
                    >
                      {t("connectCodex")}
                    </Button>
                  )}
                </div>

                {codexDeviceAuth && (
                  <div className="grid gap-2 rounded-lg bg-[#e8e6dc] p-3 dark:bg-[#242423]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium uppercase text-[#77756f] dark:text-[#b0aea5]">
                        {t("codexDeviceCode")}
                      </span>
                      <code className="rounded-md bg-[#f7f5ed] px-2 py-1 text-sm font-semibold tracking-normal text-[#141413] dark:bg-[#30302e] dark:text-[#faf9f5]">
                        {codexDeviceAuth.code}
                      </code>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        className="h-8 w-8 min-w-8"
                        onPress={handleCopyCodexDeviceCode}
                        aria-label={t("copyCodexDeviceCode")}
                      >
                        <Icon icon="lucide:copy" className="text-sm" />
                      </Button>
                    </div>
                    <Button
                      as="a"
                      href={codexDeviceAuth.url}
                      target="_blank"
                      rel="noreferrer"
                      size="sm"
                      variant="flat"
                      className="justify-self-start"
                      startContent={<Icon icon="lucide:external-link" />}
                    >
                      {t("openCodexLogin")}
                    </Button>
                    <Button
                      size="sm"
                      variant="light"
                      className="justify-self-start"
                      isLoading={isUpdatingCodex}
                      startContent={!isUpdatingCodex ? <Icon icon="lucide:x" /> : undefined}
                      onPress={handleCancelCodexDeviceAuth}
                    >
                      {t("cancelCodexLogin")}
                    </Button>
                  </div>
                )}

                {codexMessage && (
                  <p className="text-xs leading-5 text-[#2f7d4f] dark:text-[#7ed9a3]">{codexMessage}</p>
                )}
                {codexError && (
                  <p className="text-xs leading-5 text-[#b54832] dark:text-[#ff8b6e]">{codexError}</p>
                )}
              </div>
            </div>
          </section>
        )}

        <section className="mt-8 border-t border-[#dedbd0] dark:border-[#30302e]">
          <div className="flex min-h-[72px] flex-col gap-3 border-b border-[#dedbd0] py-4 dark:border-[#30302e] sm:flex-row sm:items-center">
            <div className="w-full text-sm font-medium text-[#5e5d59] dark:text-[#b0aea5] sm:w-32">
              {t("notifications")}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:max-w-sm">
              {notificationIntro && (
                <FeatureIntro
                  featureKey={notificationIntro.featureKey}
                  title={notificationIntro.title}
                  description={notificationIntro.description}
                  actionLabel={notificationIntro.actionLabel}
                  onAction={notificationIntro.onAction}
                  actionIcon={notificationIntro.actionIcon}
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Chip
                  size="sm"
                  variant="flat"
                  color={pushStatus === 'subscribed' ? 'success' : pushStatus === 'denied' ? 'danger' : 'default'}
                >
                  {pushStatusLabel}
                </Chip>
                {pushStatus === 'subscribed' ? (
                  <Button
                    size="sm"
                    variant="flat"
                    isLoading={isUpdatingPush}
                    startContent={!isUpdatingPush ? <Icon icon="lucide:bell-off" /> : undefined}
                    onPress={handleDisablePush}
                  >
                    {t("disableNotifications")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    color="secondary"
                    className="bg-[#c96442] text-[#faf9f5]"
                    isDisabled={pushStatus === 'unsupported' || pushStatus === 'ios-install-required' || pushStatus === 'server-disabled' || pushStatus === 'denied'}
                    isLoading={isUpdatingPush}
                    startContent={!isUpdatingPush ? <Icon icon="lucide:bell" /> : undefined}
                    onPress={handleEnablePush}
                  >
                    {t("enableNotifications")}
                  </Button>
                )}
              </div>
              <p className="text-xs leading-5 text-[#77756f] dark:text-[#b0aea5]">
                {pushStatus === 'denied'
                  ? t("notificationDeniedHelp")
                  : pushStatus === 'ios-install-required'
                    ? t("notificationIOSInstallHelp")
                    : t("notificationHelp")}
              </p>
              {pushError && (
                <p className="text-xs leading-5 text-[#b54832] dark:text-[#ff8b6e]">{pushError}</p>
              )}
            </div>
          </div>

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
    <Modal
      isOpen={isCodexLoginModalOpen && Boolean(codexDeviceAuth)}
      onClose={handleCloseCodexLoginModal}
      size="sm"
      scrollBehavior="inside"
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          {t("codexLoginTitle")}
        </ModalHeader>
        <ModalBody>
          <div className="grid gap-4">
            <p className="text-sm leading-6 text-[#5e5d59] dark:text-[#b0aea5]">
              {t("codexLoginModalDescription")}
            </p>
            {codexDeviceAuth && (
              <div className="grid gap-3 rounded-lg bg-[#e8e6dc] p-4 dark:bg-[#242423]">
                <div className="grid gap-1">
                  <span className="text-xs font-medium uppercase text-[#77756f] dark:text-[#b0aea5]">
                    {t("codexDeviceCode")}
                  </span>
                  <code className="w-full rounded-md bg-[#f7f5ed] px-3 py-2 text-center text-lg font-semibold tracking-normal text-[#141413] dark:bg-[#30302e] dark:text-[#faf9f5]">
                    {codexDeviceAuth.code}
                  </code>
                </div>
                {codexExpiryLabel && (
                  <p className="text-xs leading-5 text-[#77756f] dark:text-[#b0aea5]">
                    {codexExpiryLabel}
                  </p>
                )}
              </div>
            )}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="light"
            isLoading={isUpdatingCodex}
            startContent={!isUpdatingCodex ? <Icon icon="lucide:x" /> : undefined}
            onPress={handleCancelCodexDeviceAuth}
          >
            {t("cancelCodexLogin")}
          </Button>
          {codexDeviceAuth && (
            <Button
              variant="flat"
              startContent={<Icon icon="lucide:copy" />}
              onPress={handleCopyCodexDeviceCode}
            >
              {t("copyCodexDeviceCode")}
            </Button>
          )}
          {codexDeviceAuth && (
            <Button
              as="a"
              href={codexDeviceAuth.url}
              target="_blank"
              rel="noreferrer"
              color="secondary"
              className="bg-[#c96442] text-[#faf9f5]"
              startContent={<Icon icon="lucide:external-link" />}
            >
              {t("openCodexLogin")}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
    </>
  );
};

const formatCountdown = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
};
