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

export function removeNonAlphanumericChars(input: string): string {
  // Remove any non-alphanumeric characters from the beginning of the string.
  return input.replace(/^[^a-zA-Z0-9]+/, '').trim();
}
