import chalk from 'chalk';
import winston from 'winston';

const logger: winston.Logger = createLogger();

type Log = {
  level: string;
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
};

export function log(log: Log) {
  logger.log(log.level, log.message, ...log.args);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function debug(message: string = '', ...args: any[]) {
  log({
    level: 'debug',
    message: chalk.blue(message),
    args: args,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function exception(message: string = '', ...args: any[]) {
  log({
    level: 'error',
    message: chalk.red(`ERROR: ${message}`),
    args: args,
  });
}

export function linebreak() {
  log({
    level: 'info',
    message: '',
    args: [],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bold(message: string = '', ...args: any[]) {
  log({
    level: 'info',
    message: chalk.bold(message),
    args: args,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function success(message: string = '', ...args: any[]) {
  log({
    level: 'info',
    message: `${chalk.green('[✓]')} ${message}`,
    args: args,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function failure(message: string = '', ...args: any[]) {
  log({
    level: 'error',
    message: `${chalk.red('[✗]')} ${message}`,
    args: args,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function error(message: string = '', ...args: any[]) {
  log({
    level: 'error',
    message: chalk.red(`Error: ${message}`),
    args: args,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function warning(message: string = '', ...args: any[]) {
  log({
    level: 'warn',
    message: `${chalk.yellow('[!]')} ${message}`,
    args: args,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function alert(message: string = '', ...args: any[]) {
  log({
    level: 'warn',
    message: chalk.yellow(`Warning: ${message}`),
    args: args,
  });
}

function consoleFormat() {
  return winston.format.printf(({ message }) => {
    return message;
  });
}

function fileFormat() {
  return winston.format.printf(({ level, message, timestamp }) => {
    return `[${timestamp}][${level}]: ${message}`;
  });
}

export function configureLogger(options: {
  verbose: boolean;
  logFilePath?: string;
}) {
  logger.level = options.verbose ? 'debug' : 'info';
  if (options.logFilePath && options.logFilePath !== '') {
    logger.add(
      new winston.transports.File({
        level: 'debug',
        filename: options.logFilePath,
        format: winston.format.combine(
          winston.format.timestamp(),
          fileFormat()
        ),
      })
    );
  }
}

export function isDebug(): boolean {
  return logger.level === 'debug';
}

function createLogger(): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: consoleFormat(),
    }),
  ];

  return winston.createLogger({
    level: 'info',
    transports: transports,
  });
}
