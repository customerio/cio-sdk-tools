import winston from 'winston';

export function createLogger() {
  return winston.createLogger({
    level: 'info',
    format: winston.format.errors({ stack: true }),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format(({ timestamp, level, message, ...args }) => {
            return { timestamp, level, message, ...args };
          })(),
          winston.format.json({ deterministic: false })
        ),
      }),
    ],
  });
}
