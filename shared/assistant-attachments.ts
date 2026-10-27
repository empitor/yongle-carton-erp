export const attachmentLimits = {
  fileBytes: 10 * 1024 * 1024,
  messageBytes: 30 * 1024 * 1024,
  messageCount: 6,
  userBytes: 200 * 1024 * 1024,
  totalBytes: 1024 * 1024 * 1024,
  pendingCount: 6,
};
export const attachmentAccept = '.jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt';
export type AssistantAttachment = {
  id: string;
  threadId: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'pdf' | 'office' | 'text';
  sha256: string;
  createdAt: string;
  deleted: boolean;
  transfer: 'image' | 'file' | 'text';
  width?: number;
  height?: number;
  textAvailable?: boolean;
  parseNotice?: string;
  renderedPages?: number;
};
export function officialDeepSeekEndpoint(endpoint: string | undefined) {
  try {
    return new URL(endpoint || '').hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}
