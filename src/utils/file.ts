import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { logger } from '.';

export function isDirectory(path: string): boolean {
  try {
    const stat = fs.statSync(path);
    return stat.isDirectory();
  } catch (err) {
    logger.logWithFormat((formatter) =>
      formatter.error('Error checking directory: %s', err)
    );
    return false;
  }
}

export function isDirectoryNonEmpty(path: string): boolean {
  try {
    const stat = fs.statSync(path);
    if (!stat.isDirectory()) {
      return false;
    }

    const files = fs.readdirSync(path);
    return files.length > 0;
  } catch (err) {
    logger.logWithFormat((formatter) =>
      formatter.error('Error checking directory: %s', err)
    );
    return false;
  }
}

export function readFileContent(path: string): string | undefined {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    return undefined;
  }
}

/**
 * Recursively searches for files in a directory that match the given filters, ignoring specified directories.
 *
 * @param directoryPath - The path to the directory where the search begins.
 * @param filters - A map containing named patterns to filter the search results.
 * @param ignoreDirs - An optional array of directories to ignore during the search. Defaults to an empty array.
 * @returns A promise that resolves to an object containing the search results, grouped by the keys from the filters map.
 */
export async function searchFileInDirectory(
  directoryPath: string,
  filters: Map<string, RegExp>,
  ignoreDirs: string[] = []
): Promise<Record<string, string[]>> {
  const results: Record<string, string[]> = Object.fromEntries(
    [...filters.keys()].map((key) => [key, []])
  );

  const files = fs.readdirSync(directoryPath);
  const tasks = files.map(async (file) => {
    const filename = path.join(directoryPath, file);
    const stat = fs.lstatSync(filename);

    // Skip the specified directories and their subdirectories
    if (ignoreDirs.some((dir) => filename.includes(dir))) return;

    if (stat.isDirectory()) {
      const subDirResults = await searchFileInDirectory(filename, filters);
      for (const key of filters.keys()) {
        results[key] = results[key].concat(subDirResults[key]);
      }
    } else {
      for (const [key, filter] of filters.entries()) {
        if (filter.test(filename)) results[key].push(filename);
      }
    }
  });

  // Wait for all tasks to complete
  await Promise.all(tasks);
  return results;
}

export async function readAndParseXML(
  filePath: string
): Promise<any | undefined> {
  const xml = fs.readFileSync(filePath, 'utf8');
  const content = await xml2js.parseStringPromise(xml, {
    explicitArray: false,
  });
  return content;
}

export function readFileWithStats(paths: string[]): any[] {
  type Result = {
    path: string;
    content?: string;
    lastUpdated?: number;
  };

  const results: Result[] = [];
  for (const path of paths) {
    const result: Result = {
      path: path,
    };
    try {
      result.content = fs.readFileSync(path, 'utf8');
      result.lastUpdated = fs.statSync(path).mtime.getTime();
    } catch (err) {
      /* empty */
    }
    results.push(result);
  }
  return results;
}
