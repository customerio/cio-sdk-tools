import { logger } from '.';

export function runCatching<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (...args: any[]) => T | Promise<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError?: (error: any) => void
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async function (...args: any[]) {
    try {
      const result = fn(...args);
      return result instanceof Promise ? await result : result;
    } catch (error) {
      if (onError) {
        onError(error);
      } else {
        logger.error(`An error occurred in function ${fn.name}:`, error);
      }
    }
  };
}
