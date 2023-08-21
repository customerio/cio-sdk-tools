import chalk from 'chalk';
import * as os from 'os';
import * as path from 'path';
import winston from 'winston';

const logger: winston.Logger = createLogger();

export function log(log: Log) {
  logger.log(log.level, log.message, ...log.args);
}

export function logWithFormat(
  callback: (formatter: typeof messageFormatter) => Log
) {
  log(callback(messageFormatter));
}

export interface Log {
  level: string;
  message: string;
  args: any[];
}

function defineLogStyle(config: { level: string; icon: string }) {
  return function format(message: string, ...args: any[]): Log {
    const formattedMessage = config.icon
      ? `${config.icon} ${message}`
      : message;

    const msg: Log = {
      level: config.level,
      message: formattedMessage,
      args,
    };

    return msg;
  };
}

export const messageFormatter = {
  debug: defineLogStyle({ level: 'debug', icon: '' }),
  error: defineLogStyle({
    level: 'error',
    icon: chalk.red('🚫🚫🚫'),
  }),
  failure: defineLogStyle({
    level: 'error',
    icon: chalk.red('[✗]'),
  }),
  info: defineLogStyle({
    level: 'info',
    icon: chalk.cyan('[i]'),
  }),
  progress: defineLogStyle({
    level: 'info',
    icon: chalk.blue('[○]'),
  }),
  result: defineLogStyle({
    level: 'info',
    icon: chalk.keyword('orange')('[→]'),
  }),
  search: defineLogStyle({
    level: 'info',
    icon: chalk.green('[🔎]'),
  }),
  success: defineLogStyle({
    level: 'info',
    icon: chalk.green('[✓]'),
  }),
  warning: defineLogStyle({
    level: 'warn',
    icon: chalk.yellow('[!]'),
  }),
};

export { messageFormatter as formatter };

function createLogger(): winston.Logger {
  const args = process.argv;
  const supportedLogLevel = ['error', 'warn', 'info', 'debug'];

  // Extract log level from command line arguments
  const logLevelArg = process.argv.find(
    (arg) => arg.startsWith('-l=') || arg.startsWith('--log-level=')
  );
  let logLevel = logLevelArg ? logLevelArg.split('=')[1] : 'info';
  if (!supportedLogLevel.includes(logLevel)) {
    logLevel = 'info';
  }

  // Extract output filename from command line arguments
  const saveOutputArg = args.find((arg) => arg.startsWith('--save-report='));
  const outputPath = saveOutputArg ? saveOutputArg.split('=')[1] : undefined;

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ];
  if (outputPath) {
    let destination;
    if (outputPath === '') {
      destination = path.join(
        os.homedir(),
        'Desktop',
        'cio-sdk-tools-output.logs'
      );
    } else {
      destination = outputPath;
    }
    transports.push(new winston.transports.File({ filename: destination }));
  }

  return winston.createLogger({
    level: logLevel,
    format: winston.format.json(),
    transports: transports,
  });
}
