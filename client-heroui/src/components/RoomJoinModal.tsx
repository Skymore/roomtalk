import React from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { Room } from '../utils/types';

interface RoomJoinModalProps {
  roomToJoin: Room | null;
  handleConfirmJoin: (confirmed: boolean, password?: string) => void;
}

export const RoomJoinModal: React.FC<RoomJoinModalProps> = ({
  roomToJoin,
  handleConfirmJoin
}) => {
  const { t } = useTranslation();
  const [password, setPassword] = React.useState('');

  React.useEffect(() => {
    setPassword('');
  }, [roomToJoin?.id]);

  if (!roomToJoin) return null;

  const requiresPassword = Boolean(roomToJoin.hasPassword);

  return (
    <Modal isOpen={!!roomToJoin} onClose={() => handleConfirmJoin(false)} scrollBehavior="inside" classNames={{ wrapper: 'roomtalk-modal-viewport' }}>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">{t("confirmJoinTitle")}</ModalHeader>
        <ModalBody>
          <p>{t("confirmJoinDescription", { roomName: roomToJoin.name })}</p>
          {requiresPassword && (
            <Input
              type="password"
              label={t('password')}
              placeholder={t('enterPassword')}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={() => handleConfirmJoin(false)}>
            {t("cancel")}
          </Button>
          <Button
            color="secondary"
            onPress={() => handleConfirmJoin(true, password)}
            isDisabled={requiresPassword && !password.trim()}
            className="bg-[#c96442] text-[#faf9f5]"
          >
            {t("join")}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
