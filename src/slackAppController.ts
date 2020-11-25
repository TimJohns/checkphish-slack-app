import { Request, Response } from "express";
import { verifyRequestSignature } from "@slack/events-api";
import { PubSub } from "@google-cloud/pubsub";

const SLACK_SLASH_COMMAND = process.env.SLACK_SLASH_COMMAND;

export interface SlackAppController {
  handlePOSTSlashCommand(req: Request, res: Response): Promise<void>;

  verifyURLEncodedBody(req: Request, buf: Buffer, encoding: BufferEncoding): void;
};

export function createSlackAppController(signingSecret: string) {
  const pubSubClient = new PubSub();
  return new SlackAppControllerImpl(signingSecret, pubSubClient);
};

class SlackAppControllerImpl implements SlackAppController {
  private signingSecret: string;
  private pubSubClient: PubSub;

  constructor(signingSecret: string, pubSubClient: PubSub) {
    this.signingSecret = signingSecret;
    this.pubSubClient = pubSubClient;
  };

  verifyURLEncodedBody (req: Request, buf: Buffer, encoding: BufferEncoding) {
    const signingSecret = this.signingSecret;
    const requestSignature = req.header('x-slack-signature');
    const requestTimestamp = Number(req.header('x-slack-request-timestamp'));

    console.log('Verifying Slack request signature.');

    const body = buf.toString(encoding || 'utf8');

    // Validate signature - throws if invalid.
    req.slackSignatureVerified = verifyRequestSignature({
      signingSecret,
      requestSignature,
      requestTimestamp,
      body
    });

    console.log('Signature verified.');
  }

  async handlePOSTSlashCommand(req: Request, res: Response) {
    const pubSubClient = this.pubSubClient;

    // Check that the signature was verified by the bodyparser middleware
    if (!req.slackSignatureVerified) {
      const error = Error('Received slash command without a verified signature.');
      error.status = 403;
      console.warn(error.message);
      throw error;
    }

    async function defaultScanURLCommand() {

      const url = req.body.text;

      const message = {
        url,
        user_id: req.body.user_id,
        team_id: req.body.team_id,
        response_url: req.body.response_url
      };

      const dataBuffer = Buffer.from(JSON.stringify(message));
      await pubSubClient.topic('scan').publish(dataBuffer);
      res.status(200).json({
        response_type: 'ephemeral',
        text: `Scanning ${url}...`,
        blocks: [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "verbatim": true,
              "text": `Scanning ${url}...`
            }
          }
        ]
      });
    }

    async function helpCommand(hint?: string) {
      let text = `Typing \`/${SLACK_SLASH_COMMAND} [url to check]\` will submit the URL to <https://checkphish.ai/?utm_source=slack_plugin&utm_medium=slack&utm_campaign=tim_johns|CheckPhish.ai> to scan for potential phishing and fraudulent website detection, and post the results to the same channel.`;
      if (hint) {
        text = '*' + hint + '*\n\n' + text;
      }

      res.status(200).json({
        response_type: 'ephemeral',
        text: hint || `Typing /${SLACK_SLASH_COMMAND} [url to check] will submit the URL to CheckPhish.ai to scan for potential phishing and fraudulent website detection, and post the results to the same channel.`,
        blocks: [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              text
            }
          }
        ]
      });
    }

    const command = (req.body.text || "")
      .trim()
      .toLowerCase();

    switch (command) {
      case 'help':
        return helpCommand();
      case '':
        return helpCommand('Missing url to check.')
      default:
        return defaultScanURLCommand();
    }
  }
}

