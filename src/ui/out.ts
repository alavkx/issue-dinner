import { fg } from "./theme.js";

function stamp(): string {
  return fg.dim(new Date().toISOString().slice(11, 19));
}

export function line(text = ""): void {
  console.log(text);
}

export function banner(title: string): void {
  const bar = "─".repeat(Math.min(72, Math.max(title.length + 4, 40)));
  line("");
  line(fg.bold(fg.cyan(`╭${bar}╮`)));
  line(fg.bold(fg.cyan(`│ ${title.padEnd(bar.length - 2)} │`)));
  line(fg.bold(fg.cyan(`╰${bar}╯`)));
  line("");
}

export function phase(label: string, detail?: string): void {
  const head = fg.magenta(`▸ ${label}`);
  line(detail ? `${stamp()} ${head} ${fg.dim(detail)}` : `${stamp()} ${head}`);
}

export function info(msg: string): void {
  line(`${stamp()} ${fg.blue("ℹ")} ${msg}`);
}

export function success(msg: string): void {
  line(`${stamp()} ${fg.green("✓")} ${msg}`);
}

export function warn(msg: string): void {
  line(`${stamp()} ${fg.yellow("⚠")} ${msg}`);
}

export function error(msg: string): void {
  line(`${stamp()} ${fg.red("✗")} ${msg}`);
}

export function storyHeader(issueKey: string, summary: string, status?: string): void {
  const badge = status ? ` ${fg.dim(`[${status}]`)}` : "";
  line("");
  line(fg.bold(`${fg.cyan("◆")} ${issueKey}${badge}`));
  line(fg.dim(`  ${summary}`));
  line(fg.dim("  " + "·".repeat(48)));
}

export function skipStory(issueKey: string, reason: string): void {
  line(`${stamp()} ${fg.gray("⊘")} ${fg.dim(`${issueKey} — ${reason}`)}`);
}

export function holdStory(issueKey: string, reason: string): void {
  line(`${stamp()} ${fg.yellow("⏸")} ${issueKey} held — ${reason}`);
}

export function rule(): void {
  line(fg.dim("  " + "─".repeat(56)));
}
