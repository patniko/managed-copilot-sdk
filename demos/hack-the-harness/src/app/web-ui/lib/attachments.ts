import type { MessageOptions } from "@github/copilot-sdk";

export type Attachment = NonNullable<MessageOptions["attachments"]>[number];

/** Sends a browser file inline, as base64. */
export async function toAttachment(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  return {
    type: "blob",
    displayName: file.name,
    mimeType: file.type || "application/octet-stream",
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}
