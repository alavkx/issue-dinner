export function storyBranchName(stackPrefix: string, issueKey: string): string {
  return `${stackPrefix}/${issueKey.toLowerCase()}`;
}
