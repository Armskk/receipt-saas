import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { testUrls } from '../test/db';
import { cleanupWorkspaces } from '../test/seed';
import { channelMessages } from './channel-messages';
import { normalizeCode } from './channel-link-code';
import { ChannelLinkService } from './channel-link.service';

// Real Postgres, connecting as the app role (`receipts_app`) like the API does,
// so this also proves the migration granted it access to channel_link_codes.
// The table and `workspaces` are outside RLS on purpose (a bot redeems a code
// before it knows the workspace); these tests check the tenant boundary that
// remains: a code only ever links its own workspace.
describe('ChannelLinkService (integration)', () => {
  const { ownerUrl, appUrl } = testUrls();
  let owner: PrismaClient;
  let prisma: PrismaService;
  let service: ChannelLinkService;
  let a: string;
  let b: string;
  const savedAppUrl = process.env.APP_DATABASE_URL;
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const norm = (formatted: string) => normalizeCode(formatted)!;

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    process.env.APP_DATABASE_URL = appUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new ChannelLinkService(prisma);
    a = (await owner.workspace.create({ data: { name: `link-test-a-${uniq()}` } })).id;
    b = (await owner.workspace.create({ data: { name: `link-test-b-${uniq()}` } })).id;
  });

  afterAll(async () => {
    await cleanupWorkspaces(owner, [a, b]); // cascades to the link codes
    await prisma.$disconnect();
    await owner.$disconnect();
    if (savedAppUrl === undefined) delete process.env.APP_DATABASE_URL;
    else process.env.APP_DATABASE_URL = savedAppUrl;
  });

  // Start every test with both workspaces unlinked and no codes.
  beforeEach(async () => {
    await owner.channelLinkCode.deleteMany({ where: { workspaceId: { in: [a, b] } } });
    await owner.workspace.updateMany({
      where: { id: { in: [a, b] } },
      data: { lineUserId: null, telegramChatId: null },
    });
  });

  const linked = async (id: string) => {
    const w = await owner.workspace.findUniqueOrThrow({ where: { id } });
    return { line: w.lineUserId, telegram: w.telegramChatId };
  };

  describe('createCode', () => {
    it('returns a formatted code that expires in ~10 minutes and stores only its hash', async () => {
      const { code, expiresAt } = await service.createCode(a, 'LINE');
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      const ms = expiresAt.getTime() - Date.now();
      expect(ms).toBeGreaterThan(9 * 60 * 1000);
      expect(ms).toBeLessThanOrEqual(10 * 60 * 1000);

      const rows = await owner.channelLinkCode.findMany({ where: { workspaceId: a } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(norm(code));
      expect(rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('supersedes an earlier unused code for the same workspace and channel', async () => {
      const first = await service.createCode(a, 'LINE');
      const second = await service.createCode(a, 'LINE');
      expect((await service.redeem('LINE', `u-${uniq()}`, norm(first.code))).ok).toBe(false);
      expect((await service.redeem('LINE', `u-${uniq()}`, norm(second.code))).ok).toBe(true);
    });

    it('keeps the LINE and Telegram codes independent', async () => {
      const line = await service.createCode(a, 'LINE');
      await service.createCode(a, 'TELEGRAM');
      expect((await service.redeem('LINE', `u-${uniq()}`, norm(line.code))).ok).toBe(true);
    });
  });

  describe('redeem', () => {
    it("links the chat to the code's workspace only", async () => {
      const chat = `u-${uniq()}`;
      const { code } = await service.createCode(a, 'LINE');

      const result = await service.redeem('LINE', chat, norm(code));

      expect(result).toMatchObject({ ok: true, workspaceId: a });
      expect(await linked(a)).toEqual({ line: chat, telegram: null });
      expect(await linked(b)).toEqual({ line: null, telegram: null });
    });

    it('links Telegram chats the same way', async () => {
      const chat = `${Math.floor(Math.random() * 1e9)}`;
      const { code } = await service.createCode(b, 'TELEGRAM');
      expect((await service.redeem('TELEGRAM', chat, norm(code))).ok).toBe(true);
      expect(await linked(b)).toEqual({ line: null, telegram: chat });
    });

    it('is single-use', async () => {
      const { code } = await service.createCode(a, 'LINE');
      expect((await service.redeem('LINE', `u-${uniq()}`, norm(code))).ok).toBe(true);
      expect(await service.redeem('LINE', `u-${uniq()}`, norm(code))).toEqual({
        ok: false,
        reason: 'INVALID_OR_EXPIRED',
      });
    });

    it('lets only one of two simultaneous redemptions of the same code win', async () => {
      const { code } = await service.createCode(a, 'LINE');
      const results = await Promise.all([
        service.redeem('LINE', `u-${uniq()}`, norm(code)),
        service.redeem('LINE', `u-${uniq()}`, norm(code)),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });

    it('rejects an unknown code', async () => {
      expect(await service.redeem('LINE', `u-${uniq()}`, 'ABCD2345')).toEqual({
        ok: false,
        reason: 'INVALID_OR_EXPIRED',
      });
    });

    it('rejects an expired code', async () => {
      const { code } = await service.createCode(a, 'LINE');
      await owner.channelLinkCode.updateMany({
        where: { workspaceId: a },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const chat = `u-${uniq()}`;
      expect((await service.redeem('LINE', chat, norm(code))).ok).toBe(false);
      expect(await linked(a)).toEqual({ line: null, telegram: null });
    });

    it('rejects a code used on the wrong channel, without spending it', async () => {
      const { code } = await service.createCode(a, 'LINE');
      expect((await service.redeem('TELEGRAM', '123456', norm(code))).ok).toBe(false);
      expect(await linked(a)).toEqual({ line: null, telegram: null });
      // still valid on its own channel
      expect((await service.redeem('LINE', `u-${uniq()}`, norm(code))).ok).toBe(true);
    });

    it('refuses to move a chat that already belongs to another workspace, without spending the code', async () => {
      const chat = `u-${uniq()}`;
      const first = await service.createCode(a, 'LINE');
      await service.redeem('LINE', chat, norm(first.code));

      const second = await service.createCode(b, 'LINE');
      expect(await service.redeem('LINE', chat, norm(second.code))).toEqual({
        ok: false,
        reason: 'ALREADY_LINKED_ELSEWHERE',
      });
      expect(await linked(a)).toEqual({ line: chat, telegram: null });
      expect(await linked(b)).toEqual({ line: null, telegram: null });

      // after A lets go of the chat, B's unspent code works
      await service.unlink(a, 'LINE');
      expect((await service.redeem('LINE', chat, norm(second.code))).ok).toBe(true);
      expect(await linked(b)).toEqual({ line: chat, telegram: null });
    });

    it('re-linking a workspace to a different chat replaces the old one', async () => {
      const oldChat = `u-${uniq()}`;
      const newChat = `u-${uniq()}`;
      await service.redeem('LINE', oldChat, norm((await service.createCode(a, 'LINE')).code));
      await service.redeem('LINE', newChat, norm((await service.createCode(a, 'LINE')).code));
      expect(await linked(a)).toEqual({ line: newChat, telegram: null });
      expect(await service.isLinked('LINE', oldChat)).toBe(false);
    });
  });

  describe('status / unlink', () => {
    it('reports which channels are linked, without exposing the ids', async () => {
      expect(await service.status(a)).toEqual({ line: false, telegram: false });
      await service.redeem('LINE', `u-${uniq()}`, norm((await service.createCode(a, 'LINE')).code));
      expect(await service.status(a)).toEqual({ line: true, telegram: false });
    });

    it("unlinks one channel and leaves the workspace's other channel alone", async () => {
      await service.redeem('LINE', `u-${uniq()}`, norm((await service.createCode(a, 'LINE')).code));
      await service.redeem('TELEGRAM', '424242', norm((await service.createCode(a, 'TELEGRAM')).code));
      expect(await service.unlink(a, 'LINE')).toEqual({ line: false, telegram: true });
    });

    it("unlinking one workspace doesn't touch another's link", async () => {
      const chatB = `u-${uniq()}`;
      await service.redeem('LINE', chatB, norm((await service.createCode(b, 'LINE')).code));
      await service.unlink(a, 'LINE');
      expect(await service.status(b)).toEqual({ line: true, telegram: false });
    });
  });

  describe('handleText (what the bot answers)', () => {
    it('links the chat when the message is a valid code and confirms with the workspace name', async () => {
      const chat = `u-${uniq()}`;
      const { code } = await service.createCode(a, 'LINE');
      const reply = await service.handleText('LINE', chat, code.toLowerCase());
      const name = (await owner.workspace.findUniqueOrThrow({ where: { id: a } })).name;
      expect(reply).toBe(channelMessages.linked(name));
      expect(await service.isLinked('LINE', chat)).toBe(true);
    });

    it('accepts the Telegram deep-link form', async () => {
      const chat = '777001';
      const { code } = await service.createCode(a, 'TELEGRAM');
      const reply = await service.handleText('TELEGRAM', chat, `/start ${code}`);
      expect(reply).toContain('Linked');
      expect(await service.isLinked('TELEGRAM', chat)).toBe(true);
    });

    it('answers a wrong code with the invalid-code message', async () => {
      expect(await service.handleText('LINE', `u-${uniq()}`, 'ABCD-2345')).toBe(channelMessages.invalidCode);
    });

    it('answers the already-linked case', async () => {
      const chat = `u-${uniq()}`;
      await service.redeem('LINE', chat, norm((await service.createCode(a, 'LINE')).code));
      const { code } = await service.createCode(b, 'LINE');
      expect(await service.handleText('LINE', chat, code)).toBe(channelMessages.alreadyLinkedElsewhere);
    });

    it('gives an unlinked chat the how-to for any other text', async () => {
      expect(await service.handleText('LINE', `u-${uniq()}`, 'hello there')).toBe(channelMessages.notLinkedHelp);
    });

    it('stays silent for other text from an already-linked chat', async () => {
      const chat = `u-${uniq()}`;
      await service.redeem('LINE', chat, norm((await service.createCode(a, 'LINE')).code));
      expect(await service.handleText('LINE', chat, 'thanks!')).toBeNull();
    });
  });
});
