/**
 * Function to clean a string by removing single/double quotes and leading/trailing white spaces.
 * @param input - String to be cleaned.
 * @returns Cleaned string.
 */
export function trimQuotes(input: string) {
  return input.replace(/['"]/g, '').trim();
}

export function trimEqualOperator(input: string) {
  return input.replace(/^=/, '').trim();
}

export function parseVersionString(input: string): string {
  return input.replace(/[^0-9a-zA-Z.-]/g, '').trim();
}
