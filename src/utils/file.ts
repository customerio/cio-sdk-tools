import * as fs from "fs";
import * as path from "path";
import * as xml2js from "xml2js";
import { logger } from ".";

export function doesExists(path: string): boolean {
  try {
    return fs.existsSync(path);
  } catch (err) {
    logger.error("Error checking directory: %s", err);
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    const stat = fs.statSync(path);
    return stat.isDirectory();
  } catch (err) {
    logger.error("Error checking directory: %s", err);
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
    logger.error("Error checking directory: %s", err);
    return false;
  }
}

export function readDirectory(path: string): string[] | undefined {
  try {
    return fs.readdirSync(path, "utf8");
  } catch (err) {
    return undefined;
  }
}

export function readFileContent(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf8");
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
  ignoreDirs: string[] = [],
): Promise<Record<string, string[]>> {
  const results: Record<string, string[]> = Object.fromEntries(
    [...filters.keys()].map((key) => [key, []]),
  );

  const files = fs.readdirSync(directoryPath);
  const tasks = files.map(async (file) => {
    const filename = path.join(directoryPath, file);
    const stat = fs.lstatSync(filename);

    // Skip the specified directories and their subdirectories
    if (ignoreDirs.some((dir) => filename.includes(dir))) return;

    if (stat.isDirectory()) {
      const subDirResults = await searchFileInDirectory(
        filename,
        filters,
        ignoreDirs,
      );
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

export async function parseXML(
  fileContent: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | undefined> {
  try {
    return await xml2js.parseStringPromise(fileContent, {
      explicitArray: false,
    });
  } catch (err) {
    /* empty */
    return undefined;
  }
}

export async function readAndParseXML(
  filePath: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | undefined> {
  const content = readFileContent(filePath);
  return content ? await parseXML(content) : undefined;
}

type FileWithStats = {
  path: string;
  content?: string;
  lastUpdated?: number;
};

export function readFileWithStats(paths: string[]): FileWithStats[] {
  const results: FileWithStats[] = [];
  for (const path of paths) {
    const result: FileWithStats = {
      path: path,
    };
    try {
      result.content = fs.readFileSync(path, "utf8");
      result.lastUpdated = fs.statSync(path).mtime.getTime();
    } catch (err) {
      /* empty */
    }
    results.push(result);
  }
  return results;
}

export type FileLinkStats = {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
};

export function getFileLinkStats(path: string): FileLinkStats | undefined {
  try {
    const linkStat = fs.statSync(path);
    return {
      isDirectory: linkStat.isDirectory(),
      isFile: linkStat.isFile(),
      isSymbolicLink: linkStat.isSymbolicLink(),
    };
  } catch (err) {
    /* empty */
    return undefined;
  }
}

export function getFilename(absolutePath: string): string {
  try {
    return path.basename(absolutePath);
  } catch (err) {
    try {
      const parts = absolutePath.split(path.sep);
      return parts[parts.length - 1];
    } catch (err) {
      /* empty */
      return absolutePath;
    }
  }
}

export function getReadablePath(
  baseDirectoryPath: string,
  absolutePath: string,
): string {
  try {
    const directoryName = getFilename(baseDirectoryPath);
    return path.join(
      directoryName,
      path.relative(baseDirectoryPath, absolutePath),
    );
  } catch (err) {
    /* empty */
    return absolutePath;
  }
}
