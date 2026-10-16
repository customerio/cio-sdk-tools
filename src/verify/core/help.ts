import { Command, Help } from 'commander';

/**
 * Help in groups, the way people look for an option: what to run, where, which app, what
 * comes out. Commander lists options in the order they were defined, which put `--opened`
 * ahead of the `--send` it depends on and the Android options between unrelated ones.
 */
export interface HelpEntry {
  /** An option's long flag, e.g. `--depth`; its term and description come from commander. */
  option?: string;
  /** A row with no option behind it, like `-h, --help`. */
  term?: string;
  text?: string;
  /** Lines under the option's description, or on their own when there is no option. */
  lines?: string[];
}

export interface HelpGroup {
  title: string;
  entries: HelpEntry[];
}

export interface HelpLayout {
  /** Paragraphs under the usage line. */
  description: string[];
  /** Name and summary rows, e.g. the areas under `verify`. */
  commands?: { title: string; rows: [string, string][] };
  groups: HelpGroup[];
  /** Paragraphs after the options. */
  after?: string[];
  /** Blocks after the options: exit codes, examples. Lines are printed as written. */
  footer?: { title: string; lines: string[] }[];
}

/** The exit codes every area shares, for its help. */
export const EXIT_CODE_LINES = [
  '0           everything asked for passed',
  '20          the integration is broken; the report says where',
  "21          nothing failed, but something asked for couldn't be proven",
  '2           bad input: unknown option, missing answer, no project found',
  "1, 3, 4, 5  the tool couldn't run (error, login, permission, API)",
];

export function useGroupedHelp(
  command: Command,
  layout: (width: number) => HelpLayout
): void {
  command.configureHelp({
    formatHelp: (cmd: Command, helper: Help) =>
      formatGrouped(cmd, helper, layout(helpWidth())),
  });
}

function helpWidth(): number {
  return Math.max(60, Math.min(100, process.stdout.columns ?? 80));
}

function formatGrouped(cmd: Command, helper: Help, layout: HelpLayout): string {
  const width = helpWidth();
  const options = layout.groups.flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.option ? [optionNamed(cmd, entry.option)] : []
    )
  );
  const argumentsShown = helper.visibleArguments(cmd);
  const terms = [
    ...options.map((option) => helper.optionTerm(option)),
    ...layout.groups.flatMap((group) =>
      group.entries.flatMap((entry) => (entry.term ? [entry.term] : []))
    ),
    ...argumentsShown.map((argument) => helper.argumentTerm(argument)),
    ...(layout.commands?.rows.map(([name]) => name) ?? []),
  ];
  const termWidth = Math.min(
    28,
    Math.max(...terms.map((term) => term.length), 0) + 2
  );
  const descriptionWidth = Math.max(30, width - 2 - termWidth);
  const row = (term: string, text: string, extra: string[] = []): string[] => {
    const [first = '', ...rest] = wrap(text, descriptionWidth);
    const pad = ' '.repeat(2 + termWidth);
    const head =
      term.length + 2 > termWidth
        ? [`  ${term}`, `${pad}${first}`]
        : [`  ${term.padEnd(termWidth)}${first}`];
    return [
      ...head,
      ...rest.map((line) => `${pad}${line}`),
      ...extra.map((line) => `${pad}${line}`),
    ];
  };

  const out: string[] = [`Usage: ${helper.commandUsage(cmd)}`, ''];
  for (const paragraph of layout.description) {
    out.push(...wrap(paragraph, width), '');
  }
  if (argumentsShown.length > 0) {
    out.push('Arguments:');
    for (const argument of argumentsShown) {
      out.push(
        ...row(
          helper.argumentTerm(argument),
          helper.argumentDescription(argument)
        )
      );
    }
    out.push('');
  }
  if (layout.commands) {
    out.push(`${layout.commands.title}:`);
    for (const [name, summary] of layout.commands.rows) {
      out.push(...row(name, summary));
    }
    out.push('');
  }
  for (const group of layout.groups) {
    out.push(`${group.title}:`);
    for (const entry of group.entries) {
      if (entry.option) {
        const option = optionNamed(cmd, entry.option);
        out.push(
          ...row(
            helper.optionTerm(option),
            helper.optionDescription(option),
            entry.lines
          )
        );
      } else if (entry.term) {
        out.push(...row(entry.term, entry.text ?? '', entry.lines));
      } else {
        for (const line of entry.lines ?? []) {
          out.push(...wrap(line, width - 2).map((text) => `  ${text}`));
        }
      }
    }
    out.push('');
  }
  for (const paragraph of layout.after ?? []) {
    out.push(...wrap(paragraph, width), '');
  }
  for (const block of layout.footer ?? []) {
    out.push(
      `${block.title}:`,
      ...block.lines.map((line) => (line ? `  ${line}` : '')),
      ''
    );
  }
  return out.join('\n');
}

function optionNamed(cmd: Command, long: string) {
  const option = cmd.options.find(
    (candidate) => candidate.long === long || candidate.short === long
  );
  // A help layout naming an option the command does not have is a defect, caught by tests.
  if (!option) throw new Error(`help names ${long}, which ${cmd.name()} lacks`);
  return option;
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
