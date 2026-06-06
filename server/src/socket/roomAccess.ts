import { RoomStore } from '../repositories/store';
import { getRoomActor } from './roomAuthorization';

export async function hasRoomAccess(store: RoomStore, roomId: string, clientId: string): Promise<boolean> {
  return Boolean(await getRoomActor(store, roomId, clientId));
}
