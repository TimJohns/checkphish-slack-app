import { Request, Response } from "express";
import { verifyRequestSignature } from "@slack/events-api";
import { PubSub } from "@google-cloud/pubsub";

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

    // Validate signature
    if (!verifyRequestSignature({
      signingSecret,
      requestSignature,
      requestTimestamp,
      body
    })) {
      throw Error('Incorrect signature.');
    }

  }


  async handlePOSTSlashCommand(req: Request, res: Response) {
    const pubSubClient = this.pubSubClient;

    const url = (req.body.text || "");

    if (url.length < 1) {
      res.status(200).send('Missing URL.');
    } else {

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
  }
}