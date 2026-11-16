/**
 * The command that repeats a run without asking anything.
 *
 * A run that asked questions ends by printing it, the way fastlane names the option after
 * each prompt and Terraform prints the apply that matches a plan: the first run, answered by
 * hand, hands over the tenth run and the CI job. Every answer — picked, defaulted or given —
 * is a flag in it.
 */

/** One argument, or a flag and its value, kept together when the line wraps. */
export type ReplayPart = string | [flag: string, value: string];

/** Single-quoted when the shell would otherwise split or expand it. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,~-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function replayCommand(program: string, parts: ReplayPart[]): string {
  return [program, ...parts.map(partText)].join(' ');
}

/**
 * The command across several lines, each ending in ` \` so it still pastes as one. Lines
 * break only before a flag, so a flag never parts from its value.
 */
export function wrapCommand(
  command: string,
  width = 78,
  indent = '    '
): string[] {
  const lines: string[] = [];
  let current = indent;
  for (const piece of command.split(/ (?=--)/)) {
    if (current.trim() && current.length + 1 + piece.length + 2 > width) {
      lines.push(`${current} \\`);
      current = `${indent}  ${piece}`;
    } else {
      current = current.trim() ? `${current} ${piece}` : `${indent}${piece}`;
    }
  }
  lines.push(current);
  return lines;
}

function partText(part: ReplayPart): string {
  return typeof part === 'string'
    ? shellQuote(part)
    : `${part[0]} ${shellQuote(part[1])}`;
}
