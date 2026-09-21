import { Injectable, Logger } from '@nestjs/common';

// Sends replies back through the LINE / Telegram APIs. A failed or skipped
// reply is only logged: the webhook has already been acknowledged, and a
// missing reply must never stop a receipt from being processed.
@Injectable()
export class ChannelMessenger {
  private readonly logger = new Logger(ChannelMessenger.name);

  async replyLine(replyToken: string | undefined, text: string): Promise<void> {
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!replyToken || !token) {
      this.logger.warn('Skipping LINE reply: missing reply token or LINE_CHANNEL_ACCESS_TOKEN');
      return;
    }
    await this.post('LINE reply', 'https://api.line.me/v2/bot/message/reply', {
      headers: { Authorization: `Bearer ${token}` },
      body: { replyToken, messages: [{ type: 'text', text }] },
    });
  }

  async sendTelegram(chatId: string, text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      this.logger.warn('Skipping Telegram reply: TELEGRAM_BOT_TOKEN is not set');
      return;
    }
    await this.post('Telegram reply', `https://api.telegram.org/bot${token}/sendMessage`, {
      body: { chat_id: chatId, text },
    });
  }

  private async post(
    what: string,
    url: string,
    { headers = {}, body }: { headers?: Record<string, string>; body: unknown },
  ) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) this.logger.warn(`${what} failed: HTTP ${res.status}`);
    } catch (err) {
      this.logger.warn(`${what} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
