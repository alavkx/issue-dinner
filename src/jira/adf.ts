/** Convert Jira Atlassian Document Format nodes to plain text / markdown-ish text. */
export function adfToMarkdown(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";

  const n = node as Record<string, unknown>;
  const type = n.type as string | undefined;

  if (type === "text" && typeof n.text === "string") {
    let text = n.text;
    const marks = n.marks as Array<{ type: string }> | undefined;
    if (marks?.some((m) => m.type === "code")) {
      text = `\`${text}\``;
    }
    if (marks?.some((m) => m.type === "strong")) {
      text = `**${text}**`;
    }
    return text;
  }

  const content = n.content as unknown[] | undefined;
  const inner = content?.map(adfToMarkdown).join("") ?? "";

  switch (type) {
    case "doc":
    case "paragraph":
      return `${inner}\n\n`;
    case "heading": {
      const level = (n.attrs as { level?: number })?.level ?? 2;
      return `${"#".repeat(level)} ${inner}\n\n`;
    }
    case "bulletList":
      return content?.map((item) => adfToMarkdown(item)).join("") ?? "";
    case "orderedList":
      return content?.map((item) => adfToMarkdown(item)).join("") ?? "";
    case "listItem":
      return `- ${inner.trim()}\n`;
    case "hardBreak":
      return "\n";
    case "codeBlock":
      return `\`\`\`\n${inner}\n\`\`\`\n\n`;
    case "blockquote":
      return inner
        .split("\n")
        .filter(Boolean)
        .map((line) => `> ${line}`)
        .join("\n")
        .concat("\n\n");
    default:
      return inner;
  }
}

export function descriptionToText(description: unknown): string {
  if (description == null) return "";
  if (typeof description === "string") return description.trim();
  return adfToMarkdown(description).trim();
}
