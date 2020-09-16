import { Request, Response, NextFunction } from "express";
import { Secrets } from "./secrets";
import { verifyRequestSignature } from "@slack/events-api";
import { PubSub } from "@google-cloud/pubsub";

export interface SlackAppController {
  // TODO(tjohns): Figure out what these returned promises actually SHOULD be (not 'any', most likely)
  handlePOSTSlashCommand(req: Request, res: Response, next: NextFunction): Promise<any>;
};

export function createSlackAppController(secrets: Secrets) {
  const pubSubClient = new PubSub();
  return new SlackAppControllerImpl(secrets, pubSubClient);
};

class SlackAppControllerImpl implements SlackAppController {
  private secrets: Secrets;
  private pubSubClient: PubSub;

  constructor(secrets: Secrets, pubSubClient: PubSub) {
    this.secrets = secrets;
    this.pubSubClient = pubSubClient;
  };

  async handlePOSTSlashCommand(req: Request, res: Response, next: NextFunction) {
    const secrets = this.secrets;
    const pubSubClient = this.pubSubClient;

    try {

      // TODO(tjohns): Remove these console logs
      console.log(JSON.stringify({headers: req.headers}));
      console.log(JSON.stringify({scopes: req.headers['X-OAuth-Scopes']}));

      // Validate signature
      const signature = {
        signingSecret: await secrets.getSecret('slack_signing_secret'),
        requestSignature: req.header('x-slack-signature'),
        requestTimestamp: Number(req.header('x-slack-request-timestamp')),
        // @ts-ignore TODO(tjohns): Fix this, see above
        body: req.rawBody,
      };

      if (!verifyRequestSignature(signature)) {
        throw Error('Incorrect signature.');
      }

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

    } catch(error) {
      next(error);
    }
  }
}