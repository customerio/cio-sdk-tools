import path from 'path';
import { Patterns } from '../constants';
import { Context } from '../core';
import {
  FileLinkStats,
  getFileLinkStats,
  getReadablePath,
  readDirectory,
  readFileContent,
  shouldIgnoreDirectory,
} from '../utils';

export type CodeSearchConfig = {
  codePatternByExtension: Record<string, RegExp>;
  ignoreDirectories: string[];
  targetFileNames: string[];
  targetFilePatterns: string[];
};

export function searchFilesForCode(
  config: CodeSearchConfig,
  directoryPath: string
): string | undefined {
  const projectPath = Context.get().project.projectPath;
  const matchingFiles = searchFilesRecursivelyForCode(
    config,
    projectPath,
    directoryPath
  );
  if (matchingFiles.length > 0) {
    return matchingFiles.map((file) => `'${file}'`).join(', ');
  } else {
    return undefined;
  }
}

function searchFilesRecursivelyForCode(
  config: CodeSearchConfig,
  projectPath: string,
  directoryPath: string
): string[] {
  const matchingFiles: string[] = [];
  const files = readDirectory(directoryPath);
  if (!files || files.length === 0) return [];

  const targetExtensions = Object.keys(config.codePatternByExtension);
  const filePatternsForCodeInspection = config.targetFileNames
    .map((filename) =>
      Patterns.constructFilePattern(filename, targetExtensions)
    )
    .concat(
      config.targetFilePatterns.map((filename) =>
        Patterns.constructKeywordFilePattern(filename, targetExtensions)
      )
    );

  const isValidFile = (file: string, linkStat: FileLinkStats): boolean => {
    if (shouldIgnoreDirectory(file, config.ignoreDirectories)) return false;
    else if (linkStat.isSymbolicLink) return false;
    else {
      return (
        linkStat.isDirectory ||
        (linkStat.isFile && targetExtensions.includes(linkStat.extension))
      );
    }
  };

  for (const file of files) {
    const filePath = path.join(directoryPath, file);
    const linkStat = getFileLinkStats(filePath);

    if (!linkStat || !isValidFile(file, linkStat)) {
      continue;
    }

    if (linkStat.isDirectory) {
      const matches = searchFilesRecursivelyForCode(
        config,
        projectPath,
        filePath
      );
      if (matches.length > 0) {
        matchingFiles.push(...matches);
      }
    } else if (linkStat.isFile) {
      const matchingPattern = filePatternsForCodeInspection.find((pattern) =>
        pattern.test(file)
      );
      if (matchingPattern) {
        const fileContent = readFileContent(filePath);
        const codePattern = config.codePatternByExtension[linkStat.extension];
        if (fileContent && codePattern.test(fileContent)) {
          matchingFiles.push(getReadablePath(projectPath, filePath));
        }
      }
    }
  }

  return matchingFiles;
}
