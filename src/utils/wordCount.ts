/// Words in a riff, the way the publish step counts them: whitespace-separated
/// tokens that contain at least one letter or digit, so bullets, `**` and a
/// bare `#` don't count. A leading `# Title` line is left out too — it
/// becomes the frontmatter title, not part of the body.
export function countWords(markdown: string): number {
  const lines = markdown.split(/\r?\n/);
  const firstContent = lines.findIndex((l) => l.trim().length > 0);
  const body =
    firstContent >= 0 && lines[firstContent].trim().startsWith("# ")
      ? lines.slice(firstContent + 1).join("\n")
      : markdown;
  return body.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}
