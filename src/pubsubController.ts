import { Request, Response } from "express";
import {JWT} from "google-auth-library";
import { Datastore } from "@google-cloud/datastore";
import crypto from "crypto";
import defaultAxios, { AxiosInstance } from "axios";
import { SectionBlock } from "@slack/types";
import { SlackUserModel } from "./models/slackUserModel";
import { CheckPhish } from "@timjohns/checkphish";

const POLL_INTERVAL_MS = 1000;
const CHECKPHISH_API_POLL_RETRIES = 30;
const PUBSUB_PUBLISHER_SERVICE_ACCT = process.env.PUBSUB_PUBLISHER_SERVICE_ACCT;
const USER_AGENT = `${process.env.SLACK_SLASH_COMMAND}-slackapp/0.99`;

const SLACK_API_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': USER_AGENT
};

export interface PubSubController {
  handlePOSTPubSubPush(req: Request, res: Response): Promise<void>;
};

export type PubSubControllerParams = {
  userAPIKeyCipherKey: Buffer,
  audience: string,
  defaultCheckPhishAPIKey: string,
  axios?: AxiosInstance
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
  private userAPIKeyCipherKey: Buffer;
  private defaultCheckPhishAPIKey: string;
  private axios: AxiosInstance;

  constructor(
    params: PubSubControllerParams,
    authClient: JWT,
    datastore: Datastore
    ) {
      this.defaultCheckPhishAPIKey = params.defaultCheckPhishAPIKey;
      this.userAPIKeyCipherKey = params.userAPIKeyCipherKey;
      this.audience = params.audience;
      this.axios = params.axios || defaultAxios;
      this.authClient = authClient;
      this.datastore = datastore;
  };

  private async createUserAPIKeyDecipher(iv: crypto.BinaryLike): Promise<crypto.Decipher> {

    const key = this.userAPIKeyCipherKey;
    const algorithm = 'aes-256-cbc';

    return crypto.createDecipheriv(algorithm, key, iv);
  };



  private async getCheckPhishAPIKey(params: GetCheckPhishAPIParams) {

    const userId = params.user_id;
    const teamId = params.team_id;

    const datastore = this.datastore;
    const controller = this;
    const defaultCheckPhishAPIKey = this.defaultCheckPhishAPIKey;

    const decryptAPIKey = async function(encryptedAPIKey: string, apiKeyIV: string) {
      const decipher = await controller.createUserAPIKeyDecipher(apiKeyIV);
      const apiKey = decipher.update(encryptedAPIKey, 'base64', 'utf8') + decipher.final('utf8');
      return apiKey;
    };

    const slackUser = new SlackUserModel({teamId, userId});

    const query = datastore
      .createQuery()
      .filter('__key__', datastore.key(slackUser.getKeyPath()))
      .limit(1);

    const [[slackUserData]] = await datastore.runQuery(query);

    if (slackUserData && slackUserData.apiKey) {
      // The user has their own key, use it
      return await decryptAPIKey(slackUserData.apiKey, slackUserData.apiKeyIV);

    } else {

      // No team-specific or user-specific key found, use ours (the default)
      return defaultCheckPhishAPIKey;
    }
  };


  async handlePOSTPubSubPush(req: Request, res: Response) {

    const authClient = this.authClient;
    const audience = this.audience;
    const axios = this.axios;

    // Get the Cloud Pub/Sub-generated JWT in the "Authorization" header.
    const bearer = req.header('Authorization');
    if (!bearer) {
      console.error('No authorization header. Unauthorized.');
      res.setHeader("WWW-Authenticate", "Bearer realm=\"PubSub Push\"");
      res.sendStatus(401);
      return;
    }

    const [, idToken] = bearer.match(/Bearer (.*)/);
    if (!idToken) {
      console.error('No Bearer token. Unauthorized.');
      res.setHeader("WWW-Authenticate", "Bearer realm=\"PubSub Push\"");
      res.sendStatus(401);
      return;
    }

    try {

      const ticket = await authClient.verifyIdToken({
        idToken,
        audience
      });

      // I'm not sure the following check is strictly necessary.
      //
      // Per https://cloud.google.com/pubsub/docs/push#claims,
      //    "Pub/Sub requires that the user or service account used to associate a
      //     service account identity with a push subscription have the Service Account
      //     User role (roles/iam.serviceAccountUser) for the project or the service account."
      //
      // This check just makes it super-explicit that the JWT is from the INTENDED service account.
      // One downside is that if Google ever changes the email of our default App Engine service
      // account, we'll break until we sort that out.
      //
      const claim = ticket.getPayload();
      if (claim.email != PUBSUB_PUBLISHER_SERVICE_ACCT) {
        const error = Error(`PubSub push handler was called by an unexpected service account: ${claim.email}`);
        console.error(error);
        throw error;
      }

    } catch(error) {
      console.error('Incorrect credentials. Forbidden.');
      res.sendStatus(403);
      return;
    }



    console.log(JSON.stringify({body: req.body}));

    const slackPayload = JSON.parse(Buffer.from(req.body.message.data, 'base64').toString('utf-8'));

    console.log(JSON.stringify({slackPayload}));

    try {
      const apiKey = await this.getCheckPhishAPIKey({
        user_id: slackPayload.user_id,
        team_id: slackPayload.team_id
      });

      const checkphish = new CheckPhish(apiKey, {userAgent: USER_AGENT});

      const scanResponse = await checkphish.scan(slackPayload.url);

      await pollStatus(checkphish, scanResponse.jobID, slackPayload.response_url);

    } catch(error) {
      console.error(`Error: ${error.message}`);

      const responsePayload = {
        response_type: 'ephemeral',
        text: error.message,
      };

      // TODO(tjohns): Handle errors - probably just log (an actual console.error), since
      // this is itself in error handling code.
      const messageResponse = await axios(
        {
        method: 'post',
        url: slackPayload.response_url,
        headers: SLACK_API_HEADERS,
        data: responsePayload
      });

      console.log(JSON.stringify({messageResponse: messageResponse.data}));

    } finally {
      res.sendStatus(200);
    }

    // TODO(tjohns): Only poll a certain number or times, which, when combined with the
    // POLL_INTERVAL_MS and some overhead, should not exceed the PubSub acknowledgement deadline
    async function pollStatus(checkphish: CheckPhish, jobID: string, responseUrl: string, retries = 0) {

      const statusResponse = await checkphish.status(jobID, true);

      // TODO(tjohns): Delete this console log
      console.log(JSON.stringify({statusResponse}));

      if (statusResponse.status == 'DONE') {

        // TODO(tjohns): Ask Bolster team about listing these out in the API docs

        // default to whatever CheckPhish returned, verbatim
        let disposition = `*${statusResponse.disposition}*`;
        switch (statusResponse.disposition) {
          case 'clean':
            if (statusResponse.resolved) {
              disposition = '*clean* :white_check_mark:';
            } else {
              disposition = 'unable to resolve at this time, please try again later.'
            }
            break;
          case 'phish':
            disposition = '*phish* :no_entry:'
            break;
          case 'suspicious':
            disposition = '*suspicious* :face_with_raised_eyebrow:';
            break;
        }


        const block: SectionBlock = {
          type: "section",
          text: {
            type: "mrkdwn",
            verbatim: true,
            text: `Scanned ${statusResponse.url}\ndisposition: ${disposition}\n\n<${statusResponse.insights}|Click here for insights>`
          },
        };

        // TODO(tjohns): Ask Bolster team about formal semantic meaning of 'resolved' for the API docs
        if (statusResponse.resolved) {
          block.accessory =  {
            "type": "image",
            "image_url": `${statusResponse.screenshot_path}`,
            "alt_text": "Screenshot thumbnail"
          }
        }

        const responsePayload = {
          response_type: 'ephemeral',
          text: `Scanned ${statusResponse.url}`,
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
          headers: SLACK_API_HEADERS,
          data: responsePayload
        });

        console.log(JSON.stringify({messageResponse: messageResponse.data}));

      } else if (statusResponse.status == 'PENDING') {

        if (retries > CHECKPHISH_API_POLL_RETRIES) {

          const message = `Timeout scanning ${statusResponse.url}. Please try again later.`
          console.warn(JSON.stringify({message, jobID}));
          throw new Error(message);


        } else {

          return new Promise((resolve, reject) => {
            retries++;
            // TODO(tjohns) Redact API key from this log message
            console.log(JSON.stringify({messageText: 'Polling', jobID, retries}));
            setTimeout(() => {
              pollStatus(checkphish, jobID, responseUrl, retries)
              .then(resolve)
              .catch(reject);
            }, POLL_INTERVAL_MS);
          })
        }
      } else {
        throw Error(`Unexpected status from CheckPhish API: ${statusResponse.status}`);
      }
    };
  }
}
