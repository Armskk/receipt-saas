import { LineController } from './line.controller';
import { TelegramController } from './telegram.controller';
import { channelMessages } from '../workspaces/channel-messages';

// StorageService -> `minio` pulls in an ESM-only dependency jest can't parse;
// nothing here touches storage.
jest.mock('minio', () => ({ Client: class {} }));

// How the webhook controllers route a chat message: link codes, the how-to for
// unlinked chats, and photos from unlinked chats. Collaborators are stubbed —
// the linking logic itself is covered against Postgres in
// workspaces/channel-link.service.spec.ts.
describe('LINE / Telegram linking flow', () => {
  let prisma: { workspace: { findUnique: jest.Mock } };
  let channelLinks: { handleText: jest.Mock; isLinked: jest.Mock };
  let messenger: { replyLine: jest.Mock; sendTelegram: jest.Mock };
  let queue: { add: jest.Mock };
  let line: any;
  let telegram: any;

  beforeEach(() => {
    prisma = { workspace: { findUnique: jest.fn().mockResolvedValue(null) } };
    channelLinks = { handleText: jest.fn(), isLinked: jest.fn().mockResolvedValue(false) };
    messenger = { replyLine: jest.fn(), sendTelegram: jest.fn() };
    queue = { add: jest.fn() };
    const storage = {};
    const receipts = { createPending: jest.fn() };
    line = new LineController(
      prisma as any, storage as any, receipts as any, channelLinks as any, messenger as any, queue as any,
    );
    telegram = new TelegramController(
      prisma as any, storage as any, receipts as any, channelLinks as any, messenger as any, queue as any,
    );
  });

  describe('LINE', () => {
    const text = (body: string) => ({
      type: 'message',
      replyToken: 'rt-1',
      source: { userId: 'U1' },
      message: { type: 'text', text: body },
    });

    it('sends what handleText decides, using the reply token', async () => {
      channelLinks.handleText.mockResolvedValue('linked!');
      await line.handleEvent(text('ABCD-2345'));
      expect(channelLinks.handleText).toHaveBeenCalledWith('LINE', 'U1', 'ABCD-2345');
      expect(messenger.replyLine).toHaveBeenCalledWith('rt-1', 'linked!');
    });

    it('stays silent when handleText returns null', async () => {
      channelLinks.handleText.mockResolvedValue(null);
      await line.handleEvent(text('thanks'));
      expect(messenger.replyLine).not.toHaveBeenCalled();
    });

    it('tells a new follower how to connect, but not one who is already linked', async () => {
      const follow = { type: 'follow', replyToken: 'rt-2', source: { userId: 'U1' } };
      await line.handleEvent(follow);
      expect(messenger.replyLine).toHaveBeenCalledWith('rt-2', channelMessages.notLinkedHelp);

      messenger.replyLine.mockClear();
      channelLinks.isLinked.mockResolvedValue(true);
      await line.handleEvent(follow);
      expect(messenger.replyLine).not.toHaveBeenCalled();
    });

    it('answers a photo from an unlinked user with the how-to and does not queue anything', async () => {
      await line.handleEvent({
        type: 'message', replyToken: 'rt-3', source: { userId: 'U1' },
        message: { type: 'image', id: 'm1' },
      });
      expect(messenger.replyLine).toHaveBeenCalledWith('rt-3', channelMessages.notLinkedHelp);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('ignores events without a user id', async () => {
      await line.handleEvent({ type: 'message', message: { type: 'text', text: 'ABCD-2345' }, source: {} });
      expect(channelLinks.handleText).not.toHaveBeenCalled();
    });
  });

  describe('Telegram', () => {
    it('handles a "/start <code>" deep link and replies in the same chat', async () => {
      channelLinks.handleText.mockResolvedValue('linked!');
      await telegram.handleUpdate({ message: { chat: { id: 555 }, text: '/start ABCD2345' } });
      expect(channelLinks.handleText).toHaveBeenCalledWith('TELEGRAM', '555', '/start ABCD2345');
      expect(messenger.sendTelegram).toHaveBeenCalledWith('555', 'linked!');
    });

    it('stays silent when handleText returns null', async () => {
      channelLinks.handleText.mockResolvedValue(null);
      await telegram.handleUpdate({ message: { chat: { id: 555 }, text: 'thanks' } });
      expect(messenger.sendTelegram).not.toHaveBeenCalled();
    });

    it('answers a photo from an unlinked chat with the how-to and does not queue anything', async () => {
      await telegram.handleUpdate({
        message: { chat: { id: 555 }, message_id: 9, photo: [{ file_id: 'f1' }] },
      });
      expect(messenger.sendTelegram).toHaveBeenCalledWith('555', channelMessages.notLinkedHelp);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('ignores updates that are neither text nor a photo', async () => {
      await telegram.handleUpdate({ message: { chat: { id: 555 }, sticker: {} } });
      expect(messenger.sendTelegram).not.toHaveBeenCalled();
      expect(channelLinks.handleText).not.toHaveBeenCalled();
    });
  });
});
