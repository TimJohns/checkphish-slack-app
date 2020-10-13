import { Request, Response } from "express";
import {JWT} from "google-auth-library";
import { Datastore } from "@google-cloud/datastore";
import crypto from "crypto";
import defaultAxios, { AxiosInstance } from "axios";
import { SectionBlock } from "@slack/types";
import { SlackUserModel } from "./models/slackUserModel";

const POLL_INTERVAL_MS = 1000;
const CHECKPHISH_API_POLL_RETRIES = 30;
const PUBSUB_PUBLISHER_SERVICE_ACCT = process.env.PUBSUB_PUBLISHER_SERVICE_ACCT;
const CHECKPHISH_API_HOST = process.env.CHECKPHISH_API_HOST;
const USER_AGENT = `${process.env.SLACK_SLASH_COMMAND}-slackapp/0.99`;

// By coincidence these headers are the same, but to DRY it up is more confusing IMO
const CHECKPHISH_API_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': USER_AGENT
};
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

type Job = {
  apiKey: string,
  jobID: string,
  insights: boolean
};

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


    try {

      console.log(JSON.stringify({body: req.body}));

      const slackPayload = JSON.parse(Buffer.from(req.body.message.data, 'base64').toString('utf-8'));

      console.log(JSON.stringify({slackPayload}));

      const apiKey = await this.getCheckPhishAPIKey({
        user_id: slackPayload.user_id,
        team_id: slackPayload.team_id
      });

      const scanResponse = await axios(
      {
        method: 'post',
        url: `${CHECKPHISH_API_HOST}/neo/scan`,
        headers: CHECKPHISH_API_HEADERS,
        data: {
          apiKey,
          urlInfo: {
            url:  slackPayload.url
            }
          }
      });

      console.log(JSON.stringify({scanResponse: scanResponse.data}));

      if (scanResponse.data.errorMessage) {

        const message = `Error scanning ${slackPayload.url}: ${scanResponse.data.errorMessage}`
        console.log(JSON.stringify({message, scanResponse: scanResponse.data}));

        const responsePayload = {
          response_type: 'ephemeral',
          text: message,
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

      } else {

        const job = {
          apiKey,
          jobID: scanResponse.data.jobID as string,
          insights: true
        };

        await pollStatus(job, slackPayload.response_url);

      }

    } catch(error) {
      console.error(`Error: ${error.message}`);
    } finally {
      res.sendStatus(200);
    }

    // TODO(tjohns): Only poll a certain number or times, which, when combined with the
    // POLL_INTERVAL_MS and some overhead, should not exceed the PubSub acknowledgement deadline
    async function pollStatus(job: Job, responseUrl: string, retries = 0) {

      const statusResponse = await axios(
        {
        method: 'post',
        url: `${CHECKPHISH_API_HOST}/neo/scan/status`,
        headers: CHECKPHISH_API_HEADERS,
        data: job
      });

      console.log(JSON.stringify({statusResponse: statusResponse.data}));

      if (statusResponse.data.errorMessage) {

        const message = 'Error while retrieving scan results. Please try again later.'
        console.log(JSON.stringify({message, job}));

        const responsePayload = {
          response_type: 'ephemeral',
          text: message,
        };

        // TODO(tjohns): Handle errors - probably just log (an actual console.error), since
        // this is itself in error handling code.
        const messageResponse = await axios(
          {
          method: 'post',
          url: responseUrl,
          headers: SLACK_API_HEADERS,
          data: responsePayload
        });

        console.log(JSON.stringify({messageResponse: messageResponse.data}));

      } else if (statusResponse.data.status == 'DONE') {

        // TODO(tjohns): Ask Bolster team about listing these out in the API docs

        // default to whatever CheckPhish returned, verbatim
        let disposition = `*${statusResponse.data.disposition}*`;
        switch (statusResponse.data.disposition) {
          case 'clean':
            if (statusResponse.data.resolved) {
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
            text: `Scanned ${statusResponse.data.url}\ndisposition: ${disposition}\n\n<${statusResponse.data.insights}|Click here for insights>`
          },
        };

        // TODO(tjohns): Ask Bolster team about formal semantic meaning of 'resolved' for the API docs
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
          headers: SLACK_API_HEADERS,
          data: responsePayload
        });

        console.log(JSON.stringify({messageResponse: messageResponse.data}));

      } else if (statusResponse.data.status == 'PENDING') {

        if (retries > CHECKPHISH_API_POLL_RETRIES) {

          const message = `Timeout scanning ${statusResponse.data.url}. Please try again later.`
          console.warn(JSON.stringify({message, job}));

          const responsePayload = {
            response_type: 'ephemeral',
            text: message,
          };

          // TODO(tjohns): Handle errors - probably just log (an actual console.error), since
          // this is itself in error handling code.
          const messageResponse = await axios(
            {
            method: 'post',
            url: responseUrl,
            headers: SLACK_API_HEADERS,
            data: responsePayload
          });

          console.log(JSON.stringify({messageResponse: messageResponse.data}));



        } else {

          return new Promise((resolve, reject) => {
            retries++;
            // TODO(tjohns) Redact API key from this log message
            console.log(JSON.stringify({messageText: 'Polling', job, retries}));
            setTimeout(() => {
              pollStatus(job, responseUrl, retries)
              .then(resolve)
              .catch(reject);
            }, POLL_INTERVAL_MS);
          })
        }
      } else {
        throw Error(`Unexpected status from CheckPhish API: ${statusResponse.data.status}`);
      }
    };
  }
}
