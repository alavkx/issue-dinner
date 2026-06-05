export interface ParsedIssueBody {
  parent?: string;
  whatToBuild?: string;
  acceptanceCriteria: string[];
  blockedBy: string[];
}

const SECTION_RE =
  /^##\s+(Parent|What to build|Acceptance criteria|Blocked by)\s*$/im;

export function parseIssueDescription(description: string): ParsedIssueBody {
  const sections: Record<string, string> = {};
  const lines = description.split("\n");
  let current: string | null = null;
  const buf: string[] = [];

  const flush = () => {
    if (current) {
      sections[current.toLowerCase()] = buf.join("\n").trim();
      buf.length = 0;
    }
  };

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      current = m[1]!;
      continue;
    }
    if (current) buf.push(line);
  }
  flush();

  const acceptanceRaw = sections["acceptance criteria"] ?? "";
  const acceptanceCriteria = acceptanceRaw
    .split("\n")
    .map((l) => l.replace(/^-\s*\[[ xX]\]\s*/, "").trim())
    .filter((l) => l.length > 0);

  const blockedRaw = sections["blocked by"] ?? "";
  const blockedBy: string[] = [];
  for (const line of blockedRaw.split("\n")) {
    const trimmed = line.replace(/^-\s*/, "").trim();
    if (!trimmed || /none\s*[-—]/i.test(trimmed)) continue;
    const keyMatch = trimmed.match(/\b([A-Z]+-\d+)\b/);
    if (keyMatch) blockedBy.push(keyMatch[1]!);
  }

  return {
    parent: sections.parent?.match(/\b([A-Z]+-\d+)\b/)?.[1],
    whatToBuild: sections["what to build"],
    acceptanceCriteria,
    blockedBy,
  };
}
