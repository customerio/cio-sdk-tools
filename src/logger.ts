import winston from 'winston';

const consoleFormat = winston.format.printf(({ message, ...args }) => {
  // only include args if there are any
  if (Object.keys(args).length === 0) {
    return `${message}`;
  }
  return `${message} ${JSON.stringify(args, null, 4)}`;
});

export function createLogger(verbose: boolean, report?: string) {
  const logger = winston.createLogger({
    level: verbose ? 'verbose' : 'info',
    format: winston.format.errors({ stack: true }),
    transports: [
      new winston.transports.Console({
        format: consoleFormat,
      }),
    ],
  });
  if (report) {
    logger.add(
      new winston.transports.File({
        level: 'verbose',
        filename: report,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format(({ timestamp, level, message, ...args }) => {
            return { timestamp, level, message, ...args };
          })(),
          winston.format.json({ deterministic: false })
        ),
      })
    );
  }
  return logger;
}
