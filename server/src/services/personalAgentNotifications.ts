import { Logger } from '../logger';
import { RoomStore } from '../repositories/store';
import { Message, PersonalAgentNotification, Room } from '../types';
import { personalNotificationMetadata, personalPageOptions, PersonalAgentTrackingError } from './personalAgentTracking';

export class PersonalAgentNotificationService {
  constructor(private readonly store: RoomStore, private readonly logger: Logger,
    private readonly send: (notice: PersonalAgentNotification) => Promise<void>) {}
  async publish(notice: PersonalAgentNotification) {
    const saved=await this.store.savePersonalAgentNotification!(notice);
    if(saved.created)await this.deliver(saved.notification);
    return saved.notification;
  }
  async deliver(notice: PersonalAgentNotification) {
    try {await this.send(notice);}catch(error){this.logger.warn('Personal update saved; push unavailable',{error,notificationId:notice.id})}
  }
  async completed(room: Room,message: Message) {
    const clientId=room.personalAgentOwnerId;if(!clientId||room.personalAgentThreadKind!=='task')return;
    // The terminal message and update are already committed together. A crash
    // before this best-effort delivery still leaves the update in the inbox.
    const notice=await this.store.readPersonalAgentNotification!(clientId,`task:${message.id}`);
    if(notice)await this.deliver(notice);
  }
  async list(clientId: string,query: Record<string,unknown> = {}) {
    if(query.unread!==undefined && !['true','false'].includes(String(query.unread)))throw new RangeError('Invalid unread filter');
    const found=await this.store.readPersonalAgentNotifications!(clientId,{...personalPageOptions(query),unread:query.unread==='true'});
    return {...found,notifications:found.notifications.map(personalNotificationMetadata)};
  }
  async read(clientId: string,id: string) {
    if(typeof id!=='string'||!id||id.length>100)throw new RangeError('Invalid notification id');
    const notice=await this.store.markPersonalAgentNotificationRead!(clientId,id);
    if(!notice)throw new PersonalAgentTrackingError('Update not found',404);
    return {notification:personalNotificationMetadata(notice)};
  }
}
