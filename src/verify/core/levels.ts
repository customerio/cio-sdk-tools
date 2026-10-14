import { Level } from './area';
import { wrap } from './help';
import { ERROR_CODES } from './errors';
import { Asker } from './prompt';
import { ToolFailure } from './run';

/**
 * Everything about levels that does not depend on what they are: checking a given one,
 * asking for a missing one, and listing them in the help. All of it is built from the
 * area's list, so a level an area adds needs no change here.
 */

/**
 * The level for this run: the one given, else the one a person picks, else the fallback
 * when nobody can be asked. A level that cannot run yet is refused with its reason rather
 * than run and reported as skipped, because it was asked for by name.
 */
export async function resolveLevel(
  levels: Level[],
  options: {
    given?: string;
    flag: string;
    asker: Asker;
    question: string;
    /** The level a run that cannot ask takes: the one that changes nothing. */
    fallback: string;
  }
): Promise<{ level: Level; asked: boolean }> {
  if (options.given) {
    const level = levels.find((candidate) => candidate.id === options.given);
    if (!level) {
      throw new ToolFailure(
        `unknown level ${options.given} — ${options.flag} takes ${levels
          .map((candidate) => candidate.id)
          .join(', ')}`,
        ERROR_CODES.validation,
        { flag: options.flag }
      );
    }
    if (level.unavailable) {
      throw new ToolFailure(
        `${options.flag} ${level.id} isn't available yet: ${level.unavailable}`,
        ERROR_CODES.validation,
        { flag: options.flag }
      );
    }
    return { level, asked: false };
  }

  const fallback = levels.find((level) => level.id === options.fallback);
  if (!fallback) throw new Error(`no level ${options.fallback}`);
  if (!options.asker.interactive) return { level: fallback, asked: false };

  const level = await options.asker.select(
    options.question,
    levels
      .filter((candidate) => !candidate.unavailable)
      .map((candidate) => ({
        value: candidate,
        label: candidate.label,
        hint: candidate.hint ?? firstSentence(candidate.title),
      })),
    { flag: `${options.flag} <level>` }
  );
  return { level, asked: true };
}

/** The levels as help lines: id, then what it proves, wrapped under itself. */
export function levelsHelp(levels: Level[], width: number): string[] {
  const idWidth = Math.max(...levels.map((level) => level.id.length)) + 2;
  return levels.flatMap((level) => {
    const text = level.unavailable
      ? `${level.title} (not available yet)`
      : level.title;
    const [first, ...rest] = wrap(text, Math.max(20, width - idWidth));
    return [
      `${level.id.padEnd(idWidth)}${first}`,
      ...rest.map((line) => `${' '.repeat(idWidth)}${line}`),
    ];
  });
}

function firstSentence(text: string): string {
  return text.split(/[:.]/)[0];
}
