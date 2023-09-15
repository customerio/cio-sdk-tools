export function createFilePattern(fileNameWithExtension: string): RegExp {
  return new RegExp(`${fileNameWithExtension}$`);
}

export function constructFilePattern(
  fileName: string,
  extensions: string[]
): RegExp {
  const joinedExtensions = extensions
    .map((ext) => ext.replace('.', '\\.'))
    .join('|'); // Escape the dots and join with |
  return new RegExp(`${fileName}(${joinedExtensions})$`);
}

export function constructKeywordFilePattern(
  keyword: string,
  extensions: string[]
): RegExp {
  const joinedExtensions = extensions
    .map((ext) => ext.replace('.', '\\.'))
    .join('|'); // Escape the dots and join with |
  return new RegExp(`${keyword}.*(${joinedExtensions})$`, 'i');
}
