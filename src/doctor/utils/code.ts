import path from 'path';
import { Context } from '../core';
import {
  FileLinkStats,
  constructFilePattern,
  constructKeywordFilePattern,
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

class CodeSearchResult {
  constructor(
    public matchedFiles: string[],
    public searchedFiles: Set<string>,
    private config: CodeSearchConfig
  ) {}

  // Helper method to get formatted matched files as a string
  get formattedMatchedFiles(): string | undefined {
    return this.matchedFiles.length > 0
      ? this.matchedFiles.map((file) => `'${file}'`).join(', ')
      : undefined;
  }

  // Helper method to get formatted target files as a string
  get formattedTargetFileNames(): string {
    return this.config.targetFileNames.join(', ');
  }

  // Helper method to return target patterns as a string
  get formattedTargetPatterns(): string {
    return this.config.targetFilePatterns.join(', ');
  }

  // Helper method to get formatted searched files as a string
  get formattedSearchedFiles(): string {
    return [...this.searchedFiles].join(', ');
  }
}

export function searchFilesForCode(
  config: CodeSearchConfig,
  directoryPath: string
): CodeSearchResult {
  const projectPath = Context.get().project.projectPath;
  const searchedFiles: Set<string> = new Set();

  const matchingFiles = searchFilesRecursivelyForCode(
    config,
    projectPath,
    directoryPath,
    searchedFiles
  );

  return new CodeSearchResult(matchingFiles, searchedFiles, config);
}

function searchFilesRecursivelyForCode(
  config: CodeSearchConfig,
  projectPath: string,
  directoryPath: string,
  searchedFiles: Set<string>
): string[] {
  const matchingFiles: string[] = [];
  const files = readDirectory(directoryPath);
  if (!files || files.length === 0) return [];

  const targetExtensions = Object.keys(config.codePatternByExtension);
  const filePatternsForCodeInspection = config.targetFileNames
    .map((filename) => constructFilePattern(filename, targetExtensions))
    .concat(
      config.targetFilePatterns.map((filename) =>
        constructKeywordFilePattern(filename, targetExtensions)
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
      const subdirMatchingFiles = searchFilesRecursivelyForCode(
        config,
        projectPath,
        filePath,
        searchedFiles
      );
      matchingFiles.push(...subdirMatchingFiles);
    } else if (linkStat.isFile) {
      const matchingPattern = filePatternsForCodeInspection.find((pattern) =>
        pattern.test(file)
      );
      if (matchingPattern) {
        const fileContent = readFileContent(filePath);
        const codePattern = config.codePatternByExtension[linkStat.extension];
        searchedFiles.add(getReadablePath(projectPath, filePath)); // Add the file path to the set of searched files
        if (fileContent && codePattern.test(fileContent)) {
          matchingFiles.push(getReadablePath(projectPath, filePath));
        }
      }
    }
  }

  return matchingFiles;
}
