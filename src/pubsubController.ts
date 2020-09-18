import { Request, Response } from "express";
import {JWT} from "google-auth-library";
import { Datastore } from "@google-cloud/datastore";
import crypto from "crypto";
import axios from "axios";
import { SectionBlock } from "@slack/types";
import { SlackUserModel } from "./models/slackUserModel";

const POLL_INTERVAL_MS = 1000;

export interface PubSubController {
  handlePOSTPubSubPush(req: Request, res: Response): Promise<void>;
};

export type PubSubControllerParams = {
  stateTokenCipherKey: string,
  stateTokenCipherIV: string,
  audience: string,
  defaultCheckPhishAPIKey: string,
};

export function createPubSubController(params: PubSubControllerParams) {
  const datastore = new Datastore();
  const authClient = new JWT();
  return new PubSubControllerImpl(params, authClient, datastore);
};

type GetCheckPhishAPIParams = {
  user_id: string;
  team_id: string;
}

class PubSubControllerImpl implements PubSubController {
  private authClient: JWT;
  private audience: string;
  private datastore: Datastore;
  private stateTokenCipherKey: string;
  private stateTokenCipherIV: string;
  private defaultCheckPhishAPIKey: string;

  constructor(
    params: PubSubControllerParams,
    authClient: JWT,
    datastore: Datastore
    ) {
      this.stateTokenCipherKey = params.stateTokenCipherKey;
      this.stateTokenCipherIV = params.stateTokenCipherIV;
      this.defaultCheckPhishAPIKey = params.defaultCheckPhishAPIKey;
      this.audience = params.audience;
      this.authClient = authClient;
      this.datastore = datastore;
  };

  private async createDecipher(): Promise<crypto.Decipher> {

    const key = this.stateTokenCipherKey;
    const algorithm = 'aes-256-cbc';
    const iv = this.stateTokenCipherIV;

    return crypto.createDecipheriv(algorithm, key, iv);
  };



  private async getCheckPhishAPIKey(params: GetCheckPhishAPIParams) {

    const userId = params.user_id;
    const teamId = params.team_id;

    const datastore = this.datastore;
    const controller = this;
    const defaultCheckPhishAPIKey = this.defaultCheckPhishAPIKey;

    const decryptAPIKey = async function(encryptedAPIKey: string) {
      const decipher = await controller.createDecipher();
      const apiKey = decipher.update(encryptedAPIKey, 'base64', 'utf8') + decipher.final('utf8');
      return apiKey;
    };

    const slackUser = new SlackUserModel({teamId, userId});

    const query = datastore
      .createQuery('SlackUser') // TODO(tjohns): Do we need the 'kind', here, since it is also in the key filter?
      .filter('__key__', datastore.key(slackUser.getKeyPath()));

    const [[slackUserData]] = await datastore.runQuery(query);

    if (slackUserData && slackUserData.apiKey) {
      // The user has their own key, use it
      return await decryptAPIKey(slackUserData.apiKey);

    } else {

      // No team-specific or user-specific key found, use ours (the default)
      return defaultCheckPhishAPIKey;
    }
  };


  async handlePOSTPubSubPush(req: Request, res: Response) {

    const authClient = this.authClient;
    const audience = this.audience;

    // Get the Cloud Pub/Sub-generated JWT in the "Authorization" header.
    const bearer = req.header('Authorization');
    if (!bearer) {
      console.error('No authorization header. Unauthorized.');
      res.setHeader("WWW-Authenticate", "Bearer realm=\"PubSub Push\"");
      res.status(401).send('Unauthorized\n');
      return;
    }

    const [, idToken] = bearer.match(/Bearer (.*)/);
    if (!idToken) {
      console.error('No Bearer token. Unauthorized.');
      res.setHeader("WWW-Authenticate", "Bearer realm=\"PubSub Push\"");
      res.status(401).send('Unauthorized\n');
      return;
    }

    try {
      // TODO(tjohns): Remove these two log messages
      console.log({idToken});
      console.log({audience});

      const ticket = await authClient.verifyIdToken({
        idToken,
        audience
      });

      const claim = ticket.getPayload();

      // TODO(tjohns): Remove this log message
      console.log(JSON.stringify({claim}));

    } catch(error) {
      console.error('Incorrect credentials. Forbidden.');
      res.status(403).send('Forbidden\n');
      return;
    }


    try {

      console.log(JSON.stringify({body: req.body}));

      const slackPayload = JSON.parse(Buffer.from(req.body.message.data, 'base64').toString('utf-8'));

      console.log(JSON.stringify({slackPayload}));

      const apiKey = await this.getCheckPhishAPIKey({
        user_id: slackPayload.user_id,
        team_id: slackPayload.team_id
      });


      // TODO(tjohns): parameterize URL
      const scanResponse = await axios(
        {
        method: 'post',
        url: 'https://developers.checkphish.ai/api/neo/scan',
        headers: {
          'Content-Type': 'application/json'
        },
        data: {
          apiKey,
          urlInfo: {
            url:  slackPayload.url
            }
          }
      });

      console.log(JSON.stringify({scanResponse: scanResponse.data}));

      const job = {
        apiKey,
        jobID: scanResponse.data.jobID as string,
        insights: true
      };

      await pollStatus(job, slackPayload.response_url);

    } catch(error) {
      console.error(`Error: ${error.message}`);
    } finally {
      console.log('Returning 200');
      res.status(200).send();
    }
  }
}

type Job = {
  apiKey: string,
  jobID: string,
  insights: boolean
};

// TODO(tjohns): Only poll a certain number or times, which, when combined with the
// POLL_INTERVAL_MS and some overhead, should not exceed the PubSub acknowledgement deadline
async function pollStatus(job: Job, responseUrl: string) {
  // TODO(tjohns): Handle errors
  // TODO(tjohns): parameterize URL
  const statusResponse = await axios(
    {
    method: 'post',
    url: 'https://developers.checkphish.ai/api/neo/scan/status',
    headers: {
      'Content-Type': 'application/json'
    },
    data: job
  });

  console.log(JSON.stringify({statusResponse: statusResponse.data}));

  if (statusResponse.data.status == 'DONE') {

    const block: SectionBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        verbatim: true,
        text: `Scanned ${statusResponse.data.url}\ndisposition: *${statusResponse.data.disposition}*\n\n<${statusResponse.data.insights}|Click here for insights>`
      },
    };

    if (statusResponse.data.resolved) {
      block.accessory =  {
        "type": "image",
        "image_url": `${statusResponse.data.screenshot_path}`,
        "alt_text": "Screenshot thumbnail"
      }
    }

    const responsePayload = {
      response_type: 'ephemeral',
      text: `Scanned ${statusResponse.data.url}`,
      blocks: [
        block
      ]
    };

    console.log(JSON.stringify({responsePayload}));

    // TODO(tjohns): Handle errors
    const messageResponse = await axios(
      {
      method: 'post',
      url: responseUrl,
      headers: {
        'Content-Type': 'application/json'
      },
      data: responsePayload
    });

    console.log(JSON.stringify({messageResponse: messageResponse.data}));

  } else if (statusResponse.data.status == 'PENDING') {
    return new Promise((resolve, reject) => {
      // TODO(tjohns) Redact API key from this log message
      console.log(JSON.stringify({messageText: 'Polling', job}));
      setTimeout(() => {
        pollStatus(job, responseUrl)
        .then(resolve)
        .catch(reject);
      }, POLL_INTERVAL_MS);
    })
  } else {
    throw Error(`Unexpected status from CheckPhish API: ${statusResponse.data.status}`);
  }
};
