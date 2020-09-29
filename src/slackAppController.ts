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

    // Validate signature - throws if invalid.
    req.slackSignatureVerified = verifyRequestSignature({
      signingSecret,
      requestSignature,
      requestTimestamp,
      body
    });

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

    const url = (req.body.text || "");
    if (url.length < 1) {
      console.log('Received slash command with no parameters.');
      // ACK it for Slack w/200, since this isn't a REST/API error, it's a user/application-level error
      res.status(200).send('Missing URL.');
      return;
    }

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

