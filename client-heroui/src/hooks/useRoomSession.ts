import { useSyncExternalStore } from 'react';
import { roomSessionController } from '../utils/socket';

export const useRoomSession = () => useSyncExternalStore(
  roomSessionController.subscribe,
  roomSessionController.getSnapshot,
  roomSessionController.getSnapshot,
);
