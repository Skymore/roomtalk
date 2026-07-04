import React from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { HoverTooltip } from './HoverTooltip';
import {
  getRoomRoleMembers,
  lookupRoomClient,
  removeRoomAdmin,
  removeRoomMember,
  setRoomAdmin,
  socket,
  transferRoomOwnership,
  updateRoomSettings,
} from '../utils/socket';
import {
  Room,
  RoomClientLookup,
  RoomMemberRole,
  RoomPermissions,
  RoomPostingSchedule,
  RoomRoleMember,
  RoomRenameHandler,
} from '../utils/types';
import { PostingScheduleEditor } from './PostingScheduleEditor';

const localTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const roleLabelKey: Record<RoomMemberRole, string> = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
};

const roleIcon: Record<RoomMemberRole, string> = {
  owner: 'lucide:crown',
  admin: 'lucide:shield-check',
  member: 'lucide:user',
};

const roleClassName: Record<RoomMemberRole, string> = {
  owner: 'bg-[#fff1e8] text-[#9f432a] dark:bg-[#3a241b] dark:text-[#f0a081]',
  admin: 'bg-[#eef5ff] text-[#315f9c] dark:bg-[#1d2a3a] dark:text-[#9abce8]',
  member: 'bg-[#e8e6dc] text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]',
};

type SettingsTabKey = 'general' | 'schedule' | 'members' | 'transfer';

interface RoomSettingsModalProps {
  isOpen: boolean;
  room: Room;
  roomPermissions: RoomPermissions | null;
  clientId: string;
  onClose: () => void;
  onRenameRoom: RoomRenameHandler;
  onClearHistory: (confirmation: string) => unknown;
  onDeleteRoom: (roomId: string) => void;
  onRoomUpdated?: (room: Room) => void;
}

export const RoomSettingsModal: React.FC<RoomSettingsModalProps> = ({
  isOpen,
  room,
  roomPermissions,
  clientId,
  onClose,
  onRenameRoom,
  onClearHistory,
  onDeleteRoom,
  onRoomUpdated,
}) => {
  const { t } = useTranslation();
  const canManageSettings = Boolean(roomPermissions?.canManageRoom);
  const canManageAdmins = Boolean(roomPermissions?.canManageAdmins);
  const canManageMembers = Boolean(roomPermissions?.canManageMembers);
  const canTransferOwnership = Boolean(roomPermissions?.canTransferOwnership);
  const isOwner = Boolean(roomPermissions?.canTransferOwnership || room.creatorId === clientId);
  const isAdmin = roomPermissions?.role === 'admin';
  const canClearHistory = Boolean(roomPermissions?.canClearHistory);
  const canManageGeneral = Boolean(isOwner || canClearHistory || canManageSettings);

  const [activeTab, setActiveTab] = React.useState<SettingsTabKey>('general');
  const [roomName, setRoomName] = React.useState(room.name);
  const [password, setPassword] = React.useState('');
  const [hasPassword, setHasPassword] = React.useState(Boolean(room.hasPassword));
  const [scheduleEnabled, setScheduleEnabled] = React.useState(false);
  const [timezone, setTimezone] = React.useState(localTimezone());
  const [startTime, setStartTime] = React.useState('09:00');
  const [endTime, setEndTime] = React.useState('17:00');
  const [selectedDays, setSelectedDays] = React.useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [adminClientId, setAdminClientId] = React.useState('');
  const [transferClientId, setTransferClientId] = React.useState('');
  const [clearConfirmation, setClearConfirmation] = React.useState('');
  const [deleteConfirmation, setDeleteConfirmation] = React.useState('');
  const [isClearConfirmOpen, setIsClearConfirmOpen] = React.useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = React.useState(false);
  const [roleMembers, setRoleMembers] = React.useState<RoomRoleMember[]>([]);
  const [pendingTransfer, setPendingTransfer] = React.useState<RoomClientLookup | null>(null);
  const [status, setStatus] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isLoadingMembers, setIsLoadingMembers] = React.useState(false);
  const setStatusMessage = React.useCallback((message: string) => {
    setStatus({ type: 'error', message });
  }, []);

  const resetSchedule = React.useCallback(() => {
    const firstWindow = room.postingSchedule?.windows?.[0];
    setScheduleEnabled(Boolean(room.postingSchedule?.enabled));
    setTimezone(room.postingSchedule?.timezone || localTimezone());
    setStartTime(firstWindow?.start || '09:00');
    setEndTime(firstWindow?.end || '17:00');
    setSelectedDays(firstWindow?.days?.length ? firstWindow.days : [0, 1, 2, 3, 4, 5, 6]);
  }, [room.postingSchedule]);

  const loadRoleMembers = React.useCallback(async () => {
    if (!canManageMembers) {
      setRoleMembers([]);
      return;
    }

    setIsLoadingMembers(true);
    try {
      setRoleMembers(await getRoomRoleMembers(room.id));
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : t('unknownError'),
      });
    } finally {
      setIsLoadingMembers(false);
    }
  }, [canManageMembers, room.id, t]);

  const hasSeededOpenFormRef = React.useRef(false);

  React.useEffect(() => {
    if (!isOpen) {
      hasSeededOpenFormRef.current = false;
      return;
    }
    // 只在打开瞬间播种一次;打开期间收到 room_updated 不应重置正在编辑的表单
    if (hasSeededOpenFormRef.current) return;
    hasSeededOpenFormRef.current = true;

    setRoomName(room.name);
    setPassword('');
    setHasPassword(Boolean(room.hasPassword));
    resetSchedule();
    setAdminClientId('');
    setTransferClientId('');
    setClearConfirmation('');
    setDeleteConfirmation('');
    setIsClearConfirmOpen(false);
    setIsDeleteConfirmOpen(false);
    setPendingTransfer(null);
    setStatus(null);
    setActiveTab(canManageGeneral ? 'general' : canManageMembers ? 'members' : 'transfer');
  }, [canManageGeneral, canManageMembers, canManageSettings, isOpen, resetSchedule, room.name, room.hasPassword]);

  React.useEffect(() => {
    if (isOpen && canManageMembers) {
      void loadRoleMembers();
    }
  }, [canManageMembers, isOpen, loadRoleMembers]);

  React.useEffect(() => {
    if (!isOpen || !canManageMembers) {
      return;
    }

    const handleRoleMembersUpdated = (updatedRoomId: string) => {
      if (updatedRoomId === room.id) {
        void loadRoleMembers();
      }
    };

    socket.on('room_role_members_updated', handleRoleMembersUpdated);
    return () => {
      socket.off('room_role_members_updated', handleRoleMembersUpdated);
    };
  }, [canManageMembers, isOpen, loadRoleMembers, room.id]);

  const runAction = async (action: () => unknown, successMessage: string) => {
    setIsSaving(true);
    setStatus(null);
    try {
      await action();
      setStatus({ type: 'success', message: successMessage });
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : t('unknownError'),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const buildSchedule = (): RoomPostingSchedule => ({
    enabled: scheduleEnabled,
    timezone: timezone.trim() || 'UTC',
    windows: scheduleEnabled
      ? [{ days: selectedDays, start: startTime, end: endTime }]
      : [],
  });

  const displayUser = (user: { clientId: string; nickname?: string; displayId?: string }) => (
    user.nickname?.trim() || user.displayId || t('participant')
  );

  const displayUserId = (user: { clientId: string; nickname?: string; displayId?: string }) => (
    user.displayId || `${displayUser(user)}#${user.clientId.slice(-4)}`
  );

  const handleSavePassword = () => {
    const nextPassword = password.trim();
    if (!nextPassword) return;

    void runAction(async () => {
      const updatedRoom = await updateRoomSettings({ roomId: room.id, password: nextPassword });
      onRoomUpdated?.(updatedRoom);
      setPassword('');
      setHasPassword(true);
    }, t('passwordUpdated'));
  };

  const handleClearPassword = () => {
    void runAction(async () => {
      const updatedRoom = await updateRoomSettings({ roomId: room.id, clearPassword: true });
      onRoomUpdated?.(updatedRoom);
      setPassword('');
      setHasPassword(false);
    }, t('passwordCleared'));
  };

  const handleRenameRoom = () => {
    const nextName = roomName.trim();
    if (!nextName || nextName === room.name) return;

    void runAction(async () => {
      await onRenameRoom(room.id, nextName);
    }, t('roomRenamedSuccess'));
  };

  const openClearHistoryConfirm = () => {
    setClearConfirmation('');
    setStatus(null);
    setIsClearConfirmOpen(true);
  };

  const handleClearHistory = () => {
    if (clearConfirmation.trim() !== room.name) return;

    void runAction(async () => {
      await onClearHistory(clearConfirmation);
      setClearConfirmation('');
      setIsClearConfirmOpen(false);
    }, t('chatHistoryCleared'));
  };

  const openDeleteRoomConfirm = () => {
    setDeleteConfirmation('');
    setStatus(null);
    setIsDeleteConfirmOpen(true);
  };

  const handleDeleteRoom = () => {
    if (deleteConfirmation.trim() !== room.name) return;

    onDeleteRoom(room.id);
    setIsDeleteConfirmOpen(false);
    onClose();
  };

  const handleApplySchedule = () => {
    void runAction(async () => {
      const updatedRoom = await updateRoomSettings({
        roomId: room.id,
        postingSchedule: scheduleEnabled ? buildSchedule() : null,
      });
      onRoomUpdated?.(updatedRoom);
    }, t('postingScheduleUpdated'));
  };

  const handleAddAdmin = () => {
    const target = adminClientId.trim();
    if (!target) return;

    void runAction(async () => {
      const lookup = await lookupRoomClient(room.id, target);
      if (!lookup.exists || !lookup.nickname) {
        throw new Error(t('userNotFound'));
      }
      if (lookup.memberRole === 'owner') {
        throw new Error(t('userAlreadyOwner'));
      }
      if (lookup.memberRole === 'admin') {
        throw new Error(t('userAlreadyAdmin'));
      }

      await setRoomAdmin(room.id, target);
      setAdminClientId('');
      await loadRoleMembers();
    }, t('adminUpdated'));
  };

  const handleRemoveAdmin = (targetClientId?: string) => {
    const target = (targetClientId || adminClientId).trim();
    if (!target) return;

    void runAction(async () => {
      await removeRoomAdmin(room.id, target);
      if (adminClientId.trim() === target) {
        setAdminClientId('');
      }
      await loadRoleMembers();
    }, t('adminUpdated'));
  };

  const handleRemoveMember = (targetClientId: string) => {
    const target = targetClientId.trim();
    if (!target) return;

    void runAction(async () => {
      await removeRoomMember(room.id, target);
      await loadRoleMembers();
    }, t('memberRemoved'));
  };

  const handlePromoteMember = (member: RoomRoleMember) => {
    if (member.role !== 'member') return;

    void runAction(async () => {
      await setRoomAdmin(room.id, member.clientId);
      await loadRoleMembers();
    }, t('adminUpdated'));
  };

  const handleReviewTransferMember = (member: RoomRoleMember) => {
    if (member.role === 'owner' || member.clientId === clientId) return;
    setStatus(null);
    setPendingTransfer({
      clientId: member.clientId,
      exists: true,
      nickname: member.nickname,
      displayId: displayUserId(member),
      memberRole: member.role,
    });
  };

  const handleReviewTransferOwnership = async () => {
    const target = transferClientId.trim();
    if (!target) return;

    setIsSaving(true);
    setStatus(null);
    try {
      const lookup = await lookupRoomClient(room.id, target);
      if (!lookup.exists || !lookup.nickname) {
        throw new Error(t('userNotFound'));
      }
      if (lookup.memberRole === 'owner' || lookup.clientId === room.creatorId) {
        throw new Error(t('userAlreadyOwner'));
      }
      setPendingTransfer(lookup);
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : t('unknownError'),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmTransferOwnership = () => {
    if (!pendingTransfer) return;

    void runAction(async () => {
      await transferRoomOwnership(room.id, pendingTransfer.clientId);
      setTransferClientId('');
      setPendingTransfer(null);
    }, t('ownershipTransferred'));
  };

  const scheduleReady = !scheduleEnabled || (selectedDays.length > 0 && startTime !== endTime);
  const ownerMember = roleMembers.find(member => member.role === 'owner')
    || { roomId: room.id, clientId: room.creatorId, role: 'owner' as const, joinedAt: room.createdAt };
  const adminMembers = roleMembers.filter(member => member.role === 'admin');
  const regularMembers = roleMembers.filter(member => member.role === 'member');

  const availableTabs = React.useMemo<Array<{ key: SettingsTabKey; icon: string; label: string }>>(() => [
    ...(canManageGeneral ? [
      { key: 'general' as const, icon: 'lucide:settings-2', label: t('settings') },
    ] : []),
    ...(canManageSettings ? [
      { key: 'schedule' as const, icon: 'lucide:clock-3', label: t('scheduleTab') },
    ] : []),
    ...(canManageMembers ? [
      { key: 'members' as const, icon: 'lucide:users', label: t('membersTab') },
    ] : []),
    ...(canTransferOwnership ? [
      { key: 'transfer' as const, icon: 'lucide:crown', label: t('transferTab') },
    ] : []),
  ], [canManageGeneral, canManageMembers, canManageSettings, canTransferOwnership, t]);

  const renderSectionLabel = (icon: string, label: string, className?: string) => (
    <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${className || 'text-[#87867f] dark:text-[#b0aea5]'}`}>
      <Icon icon={icon} className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </div>
  );

  const renderStatusBanner = () => (
    status ? (
      <div
        className={`rounded-lg px-3 py-2 text-sm ${
          status.type === 'error'
            ? 'bg-danger-50 text-danger-700 dark:bg-danger-950/30 dark:text-danger-200'
            : 'bg-success-50 text-success-700 dark:bg-success-950/30 dark:text-success-200'
        }`}
      >
        {status.message}
      </div>
    ) : null
  );

  const canRemoveMember = (member: RoomRoleMember) => (
    canManageMembers &&
    member.role !== 'owner' &&
    member.clientId !== clientId &&
    (isOwner || member.role === 'member')
  );

  const renderMemberRow = (member: RoomRoleMember) => (
    <div
      key={`${member.role}-${member.clientId}`}
      className="flex items-center justify-between gap-3 rounded-lg border border-[#dedbd0] bg-[#faf9f5] px-3 py-2 dark:border-[#30302e] dark:bg-[#1d1d1b]"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${roleClassName[member.role]}`}>
          <Icon icon={roleIcon[member.role]} className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[#141413] dark:text-[#faf9f5]">
            {displayUser(member)}
          </div>
          <div className="truncate text-[11px] text-[#87867f] dark:text-[#b0aea5]">{displayUserId(member)}</div>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${roleClassName[member.role]}`}>
          {t(roleLabelKey[member.role])}
        </span>
        {member.role === 'member' && canManageAdmins && (
          <Button
            isIconOnly
            size="sm"
            variant="light"
            color="primary"
            aria-label={t('addAdmin')}
            isDisabled={isSaving}
            onPress={() => handlePromoteMember(member)}
          >
            <Icon icon="lucide:shield-plus" className="h-4 w-4" />
          </Button>
        )}
        {member.role === 'admin' && canManageAdmins && (
          <Button
            isIconOnly
            size="sm"
            variant="light"
            color="warning"
            aria-label={t('removeAdmin')}
            isDisabled={isSaving}
            onPress={() => handleRemoveAdmin(member.clientId)}
          >
            <Icon icon="lucide:shield-minus" className="h-4 w-4" />
          </Button>
        )}
        {canTransferOwnership && member.role !== 'owner' && member.clientId !== clientId && (
          <Button
            isIconOnly
            size="sm"
            variant="light"
            color="danger"
            aria-label={t('transferOwnership')}
            isDisabled={isSaving}
            onPress={() => handleReviewTransferMember(member)}
          >
            <Icon icon="lucide:crown" className="h-4 w-4" />
          </Button>
        )}
        {canRemoveMember(member) && (
          <Button
            isIconOnly
            size="sm"
            variant="light"
            color="danger"
            aria-label={t('removeMember')}
            isDisabled={isSaving}
            onPress={() => handleRemoveMember(member.clientId)}
          >
            <Icon icon="lucide:user-x" className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );

  const renderTabPanel = (tabKey: SettingsTabKey) => {
    if (tabKey === 'general' && canManageGeneral) {
      const roomNameChanged = roomName.trim() && roomName.trim() !== room.name;

      const showDangerZone = canClearHistory || isOwner;

      return (
        <section className="space-y-6">
          {isOwner && (
            <div className="space-y-2">
              {renderSectionLabel('lucide:tag', t('roomName'))}
              <div className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-2">
                <Input
                  aria-label={t('roomName')}
                  placeholder={t('enterRoomName')}
                  value={roomName}
                  onChange={(event) => setRoomName(event.target.value)}
                  classNames={{ inputWrapper: 'h-12' }}
                />
                <HoverTooltip content={t('save')}>
                  <Button
                    isIconOnly
                    aria-label={t('save')}
                    className="h-12 w-12 min-w-12 rounded-lg bg-[#c96442] text-[#faf9f5]"
                    isDisabled={!roomNameChanged || isSaving}
                    isLoading={isSaving}
                    onPress={handleRenameRoom}
                  >
                    <Icon icon="lucide:check" className="h-5 w-5" />
                  </Button>
                </HoverTooltip>
              </div>
            </div>
          )}

          {canManageSettings && (
            <div className="space-y-2">
              {renderSectionLabel('lucide:key-round', t('roomPassword'))}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <Input
                  type="password"
                  aria-label={t('password')}
                  placeholder={hasPassword ? '••••••••' : t('enterPassword')}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  classNames={{ inputWrapper: 'h-12' }}
                />
                <Button
                  className="h-12 rounded-lg bg-[#c96442] px-4 font-semibold text-[#faf9f5]"
                  startContent={!isSaving && <Icon icon="lucide:check" className="h-4 w-4" />}
                  isDisabled={!password.trim() || isSaving}
                  isLoading={isSaving}
                  onPress={handleSavePassword}
                >
                  {hasPassword ? t('updatePassword') : t('setPassword')}
                </Button>
              </div>
              {hasPassword ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[#dedbd0] bg-[#faf9f5] px-3 py-1.5 dark:border-[#30302e] dark:bg-[#1d1d1b]">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-[#5e8a63] dark:text-[#7faf83]">
                    <Icon icon="lucide:shield-check" className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="truncate">{t('passwordProtected')}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="light"
                    color="danger"
                    className="h-7 flex-shrink-0 px-2 text-xs font-semibold"
                    startContent={<Icon icon="lucide:lock-open" className="h-3.5 w-3.5" />}
                    isDisabled={isSaving}
                    onPress={handleClearPassword}
                  >
                    {t('clearPassword')}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-[#87867f] dark:text-[#b0aea5]">
                  <Icon icon="lucide:lock-open" className="h-3 w-3" />
                  {t('noPasswordSet')}
                </div>
              )}
            </div>
          )}

          {isOwner && room.type === 'coco' && (
            <div className="space-y-2">
              {renderSectionLabel('lucide:bot', t('cocoAccess'))}
              <div className="flex gap-1.5">
                {(['owner', 'admin', 'member'] as const).map(level => {
                  const current = room.cocoAccess || 'owner';
                  const selected = current === level;
                  return (
                    <Button
                      key={level}
                      size="sm"
                      className={`h-8 rounded-lg px-3 text-xs font-semibold ${
                        selected
                          ? 'bg-[#c96442] text-[#faf9f5]'
                          : 'bg-[#e8e6dc] text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]'
                      }`}
                      isDisabled={isSaving}
                      onPress={async () => {
                        if (selected) return;
                        setIsSaving(true);
                        try {
                          const updated = await updateRoomSettings({ roomId: room.id, cocoAccess: level });
                          onRoomUpdated?.(updated);
                        } catch {
                          setStatusMessage(t('settingsUpdateFailed'));
                        } finally {
                          setIsSaving(false);
                        }
                      }}
                    >
                      {t(level)}
                    </Button>
                  );
                })}
              </div>
              <div className="text-xs text-[#87867f] dark:text-[#b0aea5]">
                {t('cocoAccessDescription')}
              </div>
            </div>
          )}

          {(isOwner || isAdmin) && room.type === 'coco' && (
            <div className="space-y-2">
              {renderSectionLabel('lucide:terminal', t('codeAgentEngine'))}
              <div className="flex flex-wrap gap-1.5">
                {(['coco', 'codex'] as const).map(backend => {
                  const current = room.codeAgentBackend || 'coco';
                  const selected = current === backend;
                  return (
                    <Button
                      key={backend}
                      size="sm"
                      className={`h-8 rounded-lg px-3 text-xs font-semibold ${
                        selected
                          ? 'bg-[#c96442] text-[#faf9f5]'
                          : 'bg-[#e8e6dc] text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]'
                      }`}
                      startContent={<Icon icon={backend === 'codex' ? 'lucide:bot' : 'lucide:sparkles'} className="h-3.5 w-3.5" />}
                      isDisabled={isSaving}
                      onPress={async () => {
                        if (selected) return;
                        setIsSaving(true);
                        try {
                          const updated = await updateRoomSettings({ roomId: room.id, codeAgentBackend: backend });
                          onRoomUpdated?.(updated);
                        } catch {
                          setStatusMessage(t('settingsUpdateFailed'));
                        } finally {
                          setIsSaving(false);
                        }
                      }}
                    >
                      {backend === 'codex' ? t('codeAgentEngineCodex') : t('codeAgentEngineCoco')}
                    </Button>
                  );
                })}
              </div>
              <div className="text-xs text-[#87867f] dark:text-[#b0aea5]">
                {t('codeAgentEngineDescription')}
              </div>
            </div>
          )}

          {(isOwner || isAdmin) && room.type === 'coco' && (
            <div className="space-y-2">
              {renderSectionLabel('lucide:settings-2', t('codeAgentMode'))}
              <div className="flex gap-1.5">
                {(['plan', 'acceptEdits'] as const).map(mode => {
                  const current = room.codeAgentMode || 'plan';
                  const selected = current === mode;
                  return (
                    <Button
                      key={mode}
                      size="sm"
                      className={`h-8 rounded-lg px-3 text-xs font-semibold ${
                        selected
                          ? 'bg-[#c96442] text-[#faf9f5]'
                          : 'bg-[#e8e6dc] text-[#5e5d59] dark:bg-[#30302e] dark:text-[#b0aea5]'
                      }`}
                      isDisabled={isSaving}
                      onPress={async () => {
                        if (selected) return;
                        setIsSaving(true);
                        try {
                          const updated = await updateRoomSettings({ roomId: room.id, codeAgentMode: mode });
                          onRoomUpdated?.(updated);
                        } catch {
                          setStatusMessage(t('settingsUpdateFailed'));
                        } finally {
                          setIsSaving(false);
                        }
                      }}
                    >
                      {mode === 'plan' ? 'Plan' : 'Edit'}
                    </Button>
                  );
                })}
              </div>
              <div className="text-xs text-[#87867f] dark:text-[#b0aea5]">
                {t('codeAgentModeDescription')}
              </div>
            </div>
          )}

          {showDangerZone && (
            <div className="space-y-2.5 rounded-xl border border-danger-200/70 bg-danger-50/40 p-3 dark:border-danger-900/40 dark:bg-danger-950/15">
              {renderSectionLabel('lucide:triangle-alert', t('dangerZone'), 'text-danger-600 dark:text-danger-400')}
              {canClearHistory && (
                <Button
                  color="danger"
                  variant="light"
                  className="h-11 w-full justify-start rounded-lg px-3 text-sm font-semibold"
                  startContent={<Icon icon="lucide:eraser" className="h-4 w-4" />}
                  isDisabled={isSaving}
                  onPress={openClearHistoryConfirm}
                >
                  {t('clearChatHistory')}
                </Button>
              )}
              {isOwner && (
                <Button
                  color="danger"
                  variant="light"
                  className="h-11 w-full justify-start rounded-lg px-3 text-sm font-semibold"
                  startContent={<Icon icon="lucide:trash-2" className="h-4 w-4" />}
                  isDisabled={isSaving}
                  onPress={openDeleteRoomConfirm}
                >
                  {t('deleteRoom')}
                </Button>
              )}
            </div>
          )}

          {renderStatusBanner()}
        </section>
      );
    }

    if (tabKey === 'schedule' && canManageSettings) {
      return (
        <section className="space-y-4">
          <PostingScheduleEditor
            enabled={scheduleEnabled}
            timezone={timezone}
            startTime={startTime}
            endTime={endTime}
            selectedDays={selectedDays}
            onEnabledChange={setScheduleEnabled}
            onTimezoneChange={setTimezone}
            onStartTimeChange={setStartTime}
            onEndTimeChange={setEndTime}
            onSelectedDaysChange={setSelectedDays}
          />
          <div className="flex justify-end border-t border-[#dedbd0] pt-4 dark:border-[#30302e]">
            <Button
              className="rounded-lg bg-[#c96442] px-5 font-semibold text-[#faf9f5]"
              startContent={!isSaving && <Icon icon="lucide:check" className="h-4 w-4" />}
              isDisabled={!scheduleReady || isSaving}
              isLoading={isSaving}
              onPress={handleApplySchedule}
            >
              {t('apply')}
            </Button>
          </div>
          {renderStatusBanner()}
        </section>
      );
    }

    if (tabKey === 'members' && canManageMembers) {
      return (
        <section className="space-y-5">
          <div className="space-y-2">
            {renderSectionLabel('lucide:users', t('memberManagement'), 'text-[#c96442] dark:text-[#e08a6a]')}
            <p className="text-xs leading-relaxed text-[#87867f] dark:text-[#b0aea5]">
              {canManageAdmins ? t('adminPermissionsHint') : t('memberPermissionsHint')}
            </p>
            {canManageAdmins && (
              <div className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-2">
                <Input
                  aria-label={t('targetClientId')}
                  placeholder={t('targetClientId')}
                  value={adminClientId}
                  onChange={(event) => setAdminClientId(event.target.value)}
                  classNames={{ inputWrapper: 'h-12' }}
                />
                <HoverTooltip content={t('addAdmin')}>
                  <Button
                    isIconOnly
                    aria-label={t('addAdmin')}
                    className="h-12 w-12 min-w-12 rounded-lg bg-[#c96442] text-[#faf9f5]"
                    isDisabled={!adminClientId.trim() || isSaving}
                    isLoading={isSaving}
                    onPress={handleAddAdmin}
                  >
                    <Icon icon="lucide:user-plus" className="h-5 w-5" />
                  </Button>
                </HoverTooltip>
              </div>
            )}
          </div>

          <div className="space-y-2">
            {renderSectionLabel('lucide:users', t('persistentMembers'))}
            {isLoadingMembers ? (
              <div className="flex items-center gap-2 text-sm text-[#87867f] dark:text-[#b0aea5]">
                <Icon icon="lucide:loader-circle" className="h-4 w-4 animate-spin" />
                {t('loading')}
              </div>
            ) : (
              <>
                {renderMemberRow(ownerMember)}
                {adminMembers.map(renderMemberRow)}
                {regularMembers.map(renderMemberRow)}
                {roleMembers.length === 0 && (
                  <div className="rounded-lg border border-dashed border-[#dedbd0] px-3 py-2 text-sm text-[#87867f] dark:border-[#30302e] dark:text-[#b0aea5]">
                    {t('noMembers')}
                  </div>
                )}
              </>
            )}
          </div>
          {renderStatusBanner()}
        </section>
      );
    }

    if (tabKey === 'transfer' && canTransferOwnership) {
      return (
        <section className="space-y-5">
          <div className="space-y-2">
            {renderSectionLabel('lucide:crown', t('transferOwnership'), 'text-danger-600 dark:text-danger-400')}
            <div className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-2">
              <Input
                aria-label={t('targetClientId')}
                placeholder={t('targetClientId')}
                value={transferClientId}
                onChange={(event) => setTransferClientId(event.target.value)}
                classNames={{ inputWrapper: 'h-12' }}
              />
              <HoverTooltip content={t('reviewTransfer')}>
                <Button
                  isIconOnly
                  aria-label={t('reviewTransfer')}
                  color="danger"
                  className="h-12 w-12 min-w-12 rounded-lg"
                  isDisabled={!transferClientId.trim() || isSaving}
                  isLoading={isSaving}
                  onPress={handleReviewTransferOwnership}
                >
                  <Icon icon="lucide:arrow-right" className="h-5 w-5" />
                </Button>
              </HoverTooltip>
            </div>
          </div>
          {renderStatusBanner()}
        </section>
      );
    }

    return null;
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        scrollBehavior="inside"
        placement="auto"
        classNames={{ wrapper: 'roomtalk-modal-viewport' }}
      >
        <ModalContent className="m-0 h-[88dvh] max-h-full w-full max-w-full rounded-b-none sm:mx-6 sm:my-16 sm:h-[560px] sm:max-h-[85dvh] sm:max-w-lg sm:rounded-large">
          <ModalHeader className="flex items-center gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[#c96442]/12 text-[#c96442] dark:bg-[#c96442]/20 dark:text-[#e08a6a]">
              <Icon icon="lucide:settings-2" className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-base font-semibold text-[#141413] dark:text-[#faf9f5]">{t('settings')}</span>
              <span className="truncate text-xs font-normal text-[#87867f] dark:text-[#b0aea5]">{room.name}</span>
            </span>
          </ModalHeader>
          <ModalBody className="min-h-0 flex-1 overflow-hidden px-6 pb-6 pt-0">
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              <div
                aria-label={t('settings')}
                className="flex w-full max-w-full gap-1 rounded-xl bg-[#e8e6dc] p-1 dark:bg-[#262624]"
                role="tablist"
              >
                {availableTabs.map((tab) => {
                  const selected = activeTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      aria-label={tab.label}
                      aria-selected={selected}
                      className={`flex h-9 min-w-0 flex-1 items-center justify-center rounded-lg transition-all ${
                        selected
                          ? 'bg-[#faf9f5] text-[#c96442] shadow-sm dark:bg-[#1d1d1b] dark:text-[#e08a6a]'
                          : 'text-[#6f6e68] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:text-[#faf9f5]'
                      }`}
                      role="tab"
                      title={tab.label}
                      onClick={() => setActiveTab(tab.key)}
                    >
                      <Icon icon={tab.icon} className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>

              <div className="relative min-h-0 flex-1 overflow-y-auto pt-5 [scrollbar-gutter:stable]">
                {renderTabPanel(activeTab)}
              </div>
            </div>
          </ModalBody>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={isClearConfirmOpen}
        onClose={() => {
          if (!isSaving) setIsClearConfirmOpen(false);
        }}
        size="sm"
        classNames={{ wrapper: 'roomtalk-modal-viewport' }}
      >
        <ModalContent>
          <ModalHeader className="flex items-center gap-2 text-danger-600 dark:text-danger-400">
            <Icon icon="lucide:eraser" className="h-5 w-5" aria-hidden="true" />
            {t('confirmClearChatTitle')}
          </ModalHeader>
          <ModalBody>
            <div className="space-y-3 text-sm text-[#4d4c48] dark:text-[#d7d5cd]">
              <p>{t('confirmClearChatDescription', { roomName: room.name })}</p>
              <Input
                label={t('confirmClearChatInputLabel')}
                description={t('typeRoomNameToConfirm', { roomName: room.name })}
                value={clearConfirmation}
                onChange={(event) => setClearConfirmation(event.target.value)}
                autoFocus
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" isDisabled={isSaving} onPress={() => setIsClearConfirmOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              color="danger"
              isDisabled={clearConfirmation.trim() !== room.name || isSaving}
              isLoading={isSaving}
              onPress={handleClearHistory}
            >
              {t('clearChatHistory')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={isDeleteConfirmOpen}
        onClose={() => {
          if (!isSaving) setIsDeleteConfirmOpen(false);
        }}
        size="sm"
        classNames={{ wrapper: 'roomtalk-modal-viewport' }}
      >
        <ModalContent>
          <ModalHeader className="flex items-center gap-2 text-danger-600 dark:text-danger-400">
            <Icon icon="lucide:trash-2" className="h-5 w-5" aria-hidden="true" />
            {t('confirmDeleteRoomTitle')}
          </ModalHeader>
          <ModalBody>
            <div className="space-y-3 text-sm text-[#4d4c48] dark:text-[#d7d5cd]">
              <p>{t('confirmDeleteRoomDescription', { roomName: room.name })}</p>
              <Input
                label={t('confirmClearChatInputLabel')}
                description={t('typeRoomNameToConfirm', { roomName: room.name })}
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                autoFocus
              />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" isDisabled={isSaving} onPress={() => setIsDeleteConfirmOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              color="danger"
              isDisabled={deleteConfirmation.trim() !== room.name || isSaving}
              onPress={handleDeleteRoom}
            >
              {t('deleteRoom')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={Boolean(pendingTransfer)}
        onClose={() => {
          if (!isSaving) setPendingTransfer(null);
        }}
        size="sm"
        classNames={{ wrapper: 'roomtalk-modal-viewport' }}
      >
        <ModalContent>
          <ModalHeader className="flex items-center gap-2 text-danger-600 dark:text-danger-400">
            <Icon icon="lucide:crown" className="h-5 w-5" aria-hidden="true" />
            {t('confirmTransferOwnership')}
          </ModalHeader>
          <ModalBody>
            {pendingTransfer && (
              <div className="space-y-3 text-sm text-[#4d4c48] dark:text-[#d7d5cd]">
                <p>
                  {t('confirmTransferToUser', { name: displayUser(pendingTransfer) })}
                </p>
                <div className="rounded-lg border border-[#dedbd0] px-3 py-2 dark:border-[#30302e]">
                  <div className="font-semibold text-[#141413] dark:text-[#faf9f5]">
                    {displayUser(pendingTransfer)}
                  </div>
                  <div className="text-[11px] text-[#87867f] dark:text-[#b0aea5]">
                    {displayUserId(pendingTransfer)}
                  </div>
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" isDisabled={isSaving} onPress={() => setPendingTransfer(null)}>
              {t('cancel')}
            </Button>
            <Button color="danger" isLoading={isSaving} onPress={handleConfirmTransferOwnership}>
              {t('transferOwnership')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
};
