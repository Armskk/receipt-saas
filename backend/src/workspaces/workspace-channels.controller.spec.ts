import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ChannelLinkService } from './channel-link.service';
import { WorkspaceChannelsController } from './workspace-channels.controller';

// Only the controller's own rules: who may connect a chat and which channel
// names are accepted. Guards (JWT + workspace membership) run before it and
// are covered by the e2e script.
describe('WorkspaceChannelsController', () => {
  let links: { createCode: jest.Mock; unlink: jest.Mock; status: jest.Mock };
  let controller: WorkspaceChannelsController;
  const reqAs = (role: string) => ({ workspaceMembership: { role } });

  beforeEach(() => {
    links = {
      createCode: jest.fn().mockResolvedValue({ code: 'ABCD-2345', expiresAt: new Date() }),
      unlink: jest.fn().mockResolvedValue({ line: false, telegram: false }),
      status: jest.fn().mockResolvedValue({ line: true, telegram: false }),
    };
    controller = new WorkspaceChannelsController(links as unknown as ChannelLinkService);
  });

  it.each(['OWNER', 'ADMIN'])('lets a %s create a code for either channel', async (role) => {
    await controller.linkCode('w1', 'line', reqAs(role));
    await controller.linkCode('w1', 'Telegram', reqAs(role));
    expect(links.createCode).toHaveBeenNthCalledWith(1, 'w1', 'LINE');
    expect(links.createCode).toHaveBeenNthCalledWith(2, 'w1', 'TELEGRAM');
  });

  it('lets an owner unlink', async () => {
    await controller.unlink('w1', 'line', reqAs('OWNER'));
    expect(links.unlink).toHaveBeenCalledWith('w1', 'LINE');
  });

  it("doesn't let a plain member create a code or unlink", () => {
    expect(() => controller.linkCode('w1', 'line', reqAs('MEMBER'))).toThrow(ForbiddenException);
    expect(() => controller.unlink('w1', 'line', reqAs('MEMBER'))).toThrow(ForbiddenException);
    expect(links.createCode).not.toHaveBeenCalled();
    expect(links.unlink).not.toHaveBeenCalled();
  });

  it("doesn't proceed when the guard left no membership on the request", () => {
    expect(() => controller.linkCode('w1', 'line', {})).toThrow(ForbiddenException);
  });

  it('rejects unknown channel names', () => {
    expect(() => controller.linkCode('w1', 'whatsapp', reqAs('OWNER'))).toThrow(BadRequestException);
    expect(() => controller.unlink('w1', 'sms', reqAs('OWNER'))).toThrow(BadRequestException);
  });

  it('lets any member read the status', async () => {
    expect(await controller.status('w1')).toEqual({ line: true, telegram: false });
  });
});
