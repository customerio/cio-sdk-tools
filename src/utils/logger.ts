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
  debug: defineLogStyle({ level: "debug", icon: "" }),
  error: defineLogStyle({
    level: "error",
    icon: chalk.red("🚫🚫🚫"),
  }),
  failure: defineLogStyle({
    level: "error",
    icon: chalk.red("[✗]"),
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
  search: defineLogStyle({
    level: "info",
    icon: chalk.green("[🔎]"),
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

export function configureLogger(options: {
  logLevel: string;
  saveReport?: string | boolean;
}) {
  logger.level = options.logLevel;
  if (options.saveReport) {
    let destination: string;
    if (options.saveReport === true || options.saveReport === "") {
      destination = path.join(
        os.homedir(),
        "Desktop",
        "cio-sdk-tools-output.logs",
      );
    } else {
      destination = options.saveReport;
    }
    logger.add(new winston.transports.File({ filename: destination }));
  }
}

function createLogger(): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  ];

  return winston.createLogger({
    level: "info",
    format: winston.format.json(),
    transports: transports,
  });
}
