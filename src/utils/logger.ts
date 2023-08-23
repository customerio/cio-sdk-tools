import chalk from "chalk";
import * as os from "os";
import * as path from "path";
import winston from "winston";

const logger: winston.Logger = createLogger();

export function log(log: Log) {
  logger.log(log.level, log.message, ...log.args);
}

export function logWithFormat(
  callback: (formatter: typeof messageFormatter) => Log,
) {
  log(callback(messageFormatter));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogFunction = (message: string, ...args: any[]) => void;

export const error: LogFunction = (message, ...args) => {
  log(messageFormatter.error(message, ...args));
};

export const failure: LogFunction = (message, ...args) => {
  log(messageFormatter.failure(message, ...args));
};

export const fatal: LogFunction = (message, ...args) => {
  log(messageFormatter.fatal(message, ...args));
};

export const info: LogFunction = (message, ...args) => {
  log(messageFormatter.info(message, ...args));
};

export const progress: LogFunction = (message, ...args) => {
  log(messageFormatter.progress(message, ...args));
};

export const result: LogFunction = (message, ...args) => {
  log(messageFormatter.result(message, ...args));
};

export const searching: LogFunction = (message, ...args) => {
  log(messageFormatter.searching(message, ...args));
};

export const success: LogFunction = (message, ...args) => {
  log(messageFormatter.success(message, ...args));
};

export const warning: LogFunction = (message, ...args) => {
  log(messageFormatter.warning(message, ...args));
};

export interface Log {
  level: string;
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
}

function defineLogStyle(config: { level: string; icon: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  error: defineLogStyle({
    level: "error",
    icon: "🚫",
  }),
  failure: defineLogStyle({
    level: "error",
    icon: chalk.red("[✗]"),
  }),
  fatal: defineLogStyle({
    level: "error",
    icon: "🚫🚫🚫",
  }),
  info: defineLogStyle({
    level: "info",
    icon: chalk.cyan("[i]"),
  }),
  progress: defineLogStyle({
    level: "info",
    icon: chalk.blue("[○]"),
  }),
  result: defineLogStyle({
    level: "info",
    icon: chalk.keyword("orange")("[→]"),
  }),
  searching: defineLogStyle({
    level: "info",
    icon: chalk.green("[⠏]"),
  }),
  success: defineLogStyle({
    level: "info",
    icon: chalk.green("[✓]"),
  }),
  warning: defineLogStyle({
    level: "warn",
    icon: chalk.yellow("[!]"),
  }),
};

export { messageFormatter as formatter };

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
  saveReport?: string;
}) {
  logger.level = options.verbose ? "info" : "warn";
  if (options.saveReport !== undefined) {
    let destination: string;
    if (options.saveReport === "") {
      destination = path.join(
        os.homedir(),
        "Desktop",
        "cio-sdk-tools-output.logs",
      );
    } else {
      destination = options.saveReport;
    }

    logger.add(
      new winston.transports.File({
        filename: destination,
        format: winston.format.combine(
          winston.format.timestamp(),
          fileFormat(),
        ),
      }),
    );
  }
}

function createLogger(): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: consoleFormat(),
    }),
  ];

  return winston.createLogger({
    level: "info",
    transports: transports,
  });
}
