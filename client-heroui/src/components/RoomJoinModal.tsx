import React from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { Room } from '../utils/types';

interface RoomJoinModalProps {
  roomToJoin: Room | null;
  handleConfirmJoin: (confirmed: boolean) => void;
}

export const RoomJoinModal: React.FC<RoomJoinModalProps> = ({
  roomToJoin,
  handleConfirmJoin
}) => {
  const { t } = useTranslation();

  if (!roomToJoin) return null;

  return (
    <Modal isOpen={!!roomToJoin} onClose={() => handleConfirmJoin(false)}>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">{t("confirmJoinTitle")}</ModalHeader>
        <ModalBody>
          <p>{t("confirmJoinDescription", { roomName: roomToJoin.name })}</p>
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={() => handleConfirmJoin(false)}>
            {t("cancel")}
          </Button>
          <Button
            color="secondary"
            onPress={() => handleConfirmJoin(true)}
            className="bg-[#c96442] text-[#faf9f5]"
          >
            {t("join")}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
