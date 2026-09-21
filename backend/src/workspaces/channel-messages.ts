// What the bots say back while linking a chat to a workspace. English first,
// Thai second — LINE users are mostly Thai.

export const channelMessages = {
  linked: (workspaceName: string) =>
    `✅ Linked to "${workspaceName}". Send a receipt photo and I'll add it.\n` +
    `เชื่อมต่อกับ "${workspaceName}" แล้ว ส่งรูปใบเสร็จมาได้เลย`,

  invalidCode:
    `That code is invalid or has expired. Generate a new one in the dashboard (Connect chat).\n` +
    `โค้ดไม่ถูกต้องหรือหมดอายุแล้ว กรุณาสร้างโค้ดใหม่ในแดชบอร์ด (Connect chat)`,

  alreadyLinkedElsewhere:
    `This chat is already linked to another workspace. Unlink it there first, then try again.\n` +
    `แชตนี้เชื่อมต่อกับ workspace อื่นอยู่แล้ว กรุณายกเลิกการเชื่อมต่อที่นั่นก่อน แล้วลองใหม่`,

  notLinkedHelp:
    `This chat isn't linked to a workspace yet. Open the dashboard → Connect chat, generate a code and send it here.\n` +
    `แชตนี้ยังไม่ได้เชื่อมต่อกับ workspace เปิดแดชบอร์ด → Connect chat สร้างโค้ดแล้วส่งมาที่นี่`,
};
