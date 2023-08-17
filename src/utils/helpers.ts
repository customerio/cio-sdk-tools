import { logger } from ".";

export function runCatching<T>(
  fn: (...args: any[]) => T | Promise<T>,
  onError?: (error: any) => void,
) {
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
