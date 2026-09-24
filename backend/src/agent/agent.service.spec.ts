import { AgentService } from './agent.service';

// AgentService -> `@anthropic-ai/sdk` talks to the real Claude API; stub the
// client and drive its tool_use response by hand.
const messagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: messagesCreate },
  })),
}));

function toolUseResponse(input: Record<string, unknown>) {
  return {
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'record_receipt', input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe('AgentService.extractReceipt', () => {
  beforeEach(() => {
    messagesCreate.mockReset();
  });

  const oneImage = [{ base64: 'ZmFrZQ==', mediaType: 'image/jpeg' }];

  it('keeps a legible merchantName', async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        merchantName: '7-Eleven',
        items: [{ description: 'Water', amount: 10 }],
        total: 10,
      }),
    );

    const result = await new AgentService().extractReceipt(oneImage);

    expect(result.parsed.merchantName).toBe('7-Eleven');
  });

  it('treats a literal "<UNKNOWN>" placeholder as omitted', async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        merchantName: '<UNKNOWN>',
        items: [{ description: 'Water', amount: 10 }],
        total: 10,
      }),
    );

    const result = await new AgentService().extractReceipt(oneImage);

    expect(result.parsed.merchantName).toBeUndefined();
  });

  it('treats "unknown" case-insensitively, with or without angle brackets', async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        merchantName: 'unknown',
        items: [{ description: 'Water', amount: 10 }],
        total: 10,
      }),
    );

    const result = await new AgentService().extractReceipt(oneImage);

    expect(result.parsed.merchantName).toBeUndefined();
  });

  it('leaves merchantName omitted when Claude omits it', async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        items: [{ description: 'Water', amount: 10 }],
        total: 10,
      }),
    );

    const result = await new AgentService().extractReceipt(oneImage);

    expect(result.parsed.merchantName).toBeUndefined();
  });
});
