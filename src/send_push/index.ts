import https from 'node:https';
import { Command, Option } from 'commander';
import { createLogger } from './logger';

export const sendPushCommand = new Command('send-push')
  .description('Send a rich push notification to a specified device.')
  .requiredOption(
    '--api-key <apiKey>',
    'App API key for your customer.io workspace. You can visit https://fly.customer.io/settings/api_credentials?keyType=app to get your API key.'
  )
  .requiredOption('--token <token>', 'Device token to send push to')
  .addOption(
    new Option('--platform <platform>', 'Platform of the device')
      .choices(['ios', 'android'])
      .makeOptionMandatory()
  )
  .addOption(
    new Option(
      '--provider <provider>',
      'Push provider to use to deliver the notification'
    ).choices(['apns', 'fcm'])
  )
  .option(
    '--deep-link <deepLink>',
    'Deep link to send in the test push notification'
  )
  .action(send);

type sendOptions = {
  apiKey: string;
  token: string;
  platform: string;
  provider: string;
  deepLink: string;
};

async function send(options: sendOptions) {
  const logger = createLogger();

  const data = JSON.stringify({
    device_token: options.token,
    device_platform: options.platform,
    deep_link: options.deepLink,
    push_provider: options.provider,
  });

  const reqOpts: https.RequestOptions = {
    port: 443,
    hostname: 'api.customer.io',
    path: '/v1/verify/push',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'Authorization': `Bearer ${options.apiKey}`,
    },
    timeout: 30_000, // 30 seconds
  };

  const req = https.request(reqOpts, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      const contentType = res.headers['content-type'];
      if (!contentType || !contentType.includes('application/json')) {
        logger.error(`something went wrong`, {
          status: res.statusCode,
          response: data,
        });
        process.exit(1);
      }

      const response = JSON.parse(data);
      if (res.statusCode !== 200) {
        logger.error(`could not send push`, { ...response });
        process.exit(1);
      }

      logger.info('success', { ...response });
    });
  });

  req.on('error', (err) => {
    logger.error(`could not make request`, { error: err });
    process.exit(1);
  });

  req.write(data);
  req.end();
}
