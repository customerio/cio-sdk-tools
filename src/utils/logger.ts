import * as os from "os";
import * as path from "path";
import winston from "winston";

const logger: winston.Logger = createLogger();

export function debug(message: string, ...args: any[]) {
  logger.debug(message, ...args);
}

export function info(message: string, ...args: any[]) {
  logger.info(message, ...args);
}

export function warn(message: string, ...args: any[]) {
  logger.warn(message, ...args);
}

export function error(message: string, ...args: any[]) {
  logger.error(message, ...args);
}

export function progress(message: string, ...args: any[]) {
  // logger.info(`[.] ${message}`, ...args);
  logger.info(`\u{1F50D} ${message}`, ...args);
}

export function result(message: string, ...args: any[]) {
  // logger.info(`\u{1F514} ${message}`, ...args);
  logger.info(`[=] ${message}`, ...args);
}

export function success(message: string, ...args: any[]) {
  // logger.info(`\u2705 ${message}`, ...args);
  logger.info(`[✓] ${message}`, ...args);
}

export function failure(message: string, ...args: any[]) {
  // logger.error(`\u{1F4A5} ${message}`, ...args);
  logger.error(`[✗] ${message}`, ...args);
}

export function warning(message: string, ...args: any[]) {
  // logger.warn(`\u26A0️ ${message}`, ...args);
  logger.warn(`[!] ${message}`, ...args);
}

function createLogger(): winston.Logger {
  const args = process.argv;
  const supportedLogLevel = ["error", "warn", "info", "debug"];

  // Extract log level from command line arguments
  const logLevelArg = process.argv.find(
    (arg) => arg.startsWith("-l=") || arg.startsWith("--log-level="),
  );
  let logLevel = logLevelArg ? logLevelArg.split("=")[1] : "info";
  if (!supportedLogLevel.includes(logLevel)) {
    logLevel = "info";
  }

  // Extract output filename from command line arguments
  const saveOutputArg = args.find((arg) => arg.startsWith("--save-report="));
  const outputPath = saveOutputArg ? saveOutputArg.split("=")[1] : undefined;

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  ];
  if (outputPath) {
    let destination;
    if (outputPath === "") {
      destination = path.join(
        os.homedir(),
        "Desktop",
        "cio-sdk-tools-output.logs",
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
