import { createLogger } from './logger';

export function handler(
  project_path: string,
  options: { verbose: boolean; report?: string }
) {
  const logger = createLogger(options.verbose, options.report);

  logger.info(`info log message with no metadata`);
  logger.info(`info log message with metatadata`, { project_path, options });

  logger.verbose(`verbose log message`, { foo: 'bar' });

  logger.error(new Error('error message'));
}
