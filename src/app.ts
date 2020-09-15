'use strict';

import { default as express, Request, Response } from "express";
import path from "path";

import {PubSub} from "@google-cloud/pubsub";
import bodyParser from "body-parser";
import {SecretManagerServiceClient} from "@google-cloud/secret-manager";
import {verifyRequestSignature} from "@slack/events-api";
import {GoogleAuth} from "google-auth-library";
import axios from "axios";
import qs from "qs";
import crypto from "crypto";

import {Datastore} from "@google-cloud/datastore";

const pubSubClient = new PubSub();
const secretManagerServiceClient = new SecretManagerServiceClient();
const auth = new GoogleAuth();
const datastore = new Datastore();

const secrets = new Map();
async function getSecret(secretName: string) {
  let secret = secrets.get(secretName);

  if (!secret) {
    console.log(`No cached secret found, fetching ${secretName} from secret manager`);

    const projectId = await auth.getProjectId();

    const [accessResponse] = await secretManagerServiceClient.accessSecretVersion({
      name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
    });

    secret = accessResponse.payload.data.toString()
    secrets.set(secretName, secret);
  }
  return secret;
}

async function createCipher() {

  const key = await getSecret('cipher_key');
  const algorithm = 'aes-256-cbc';
  const iv = process.env.CIPHER_IV;

  return crypto.createCipheriv(algorithm, key, iv);
};

async function createDecipher() {

  const key = await getSecret('cipher_key');
  const algorithm = 'aes-256-cbc';
  const iv = process.env.CIPHER_IV;

  return crypto.createDecipheriv(algorithm, key, iv);
};

const app = express();

// TODO(tjohns): rawBodySaver, while a prolific hack, is still a hack
// Consider either:
// - a PR for body-parser that leaves the rawBody in place, or
// - a PR for body-parser that makes the 'verify' async
// - writing a 'verify' that synchronously verifies the signature
function rawBodySaver (req: Request, res: Response, buf: Buffer, encoding: BufferEncoding) {
  if (buf && buf.length) {
    // @ts-ignore TODO(tjohns): Fix this, see above
    req.rawBody = buf.toString(encoding || 'utf8')
  }
}

app.use(bodyParser.urlencoded({ extended: true, verify: rawBodySaver}));
app.set( "views", path.join( __dirname, "views" ) );
app.set('view engine', 'ejs');

app.post('/', async (req: Request, res: Response, next) => {

  try {

    // TODO(tjohns): Remove these console logs
    console.log(JSON.stringify({headers: req.headers}));
    console.log(JSON.stringify({scopes: req.headers['X-OAuth-Scopes']}));

    // Validate signature
    const signature = {
      signingSecret: await getSecret('slack_signing_secret'),
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
});

app.get('/slackappinstall', async (req, res, next) => {
  try {
    // TODO(tjohns): Generate CSRF/OTP Session Token (nonce + timestamp + random)
    res.render('install');
  } catch(error) {
    next(error);
  }
})

app.post('/slackappinstall', async (req, res, next) => {

  // TODO(tjohns): Remove this console log
  console.log(JSON.stringify({body: req.body}));

  try {
    let destUrl = `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=commands&user_scope=`;
    const apiKey = (req.body.apiKey || '').trim()
    if (apiKey.length) {

      // TODO(tjohns): Verify CSRF token (I'm not sure this is strictly necessary, since the
      // apiKey is, in effect, a form of identity token, but I'm 100% certain if I DON'T
      // use a CSRF token, I'll have to explain that, since it's standard practice - and
      // of course I might be wrong!)

      // TODO(tjohns): Make a trial request with the API key to verify it's valid (at that one
      // moment, anyway)

      const stateToken = {
        apiKey
      };


      // Encrypt the state token
      const cipher = await createCipher();

      const stateTokenStr = JSON.stringify(stateToken);
      const encryptedStateToken = cipher.update(stateTokenStr, 'utf8', 'base64') + cipher.final('base64');

      destUrl += "&state=" + encodeURIComponent(encryptedStateToken);
    }
    res.redirect(destUrl);

  } catch(error) {
    next(error);
  }
})

app.get('/slackappprivacy', async (req, res, next) => {
  try {
    res.render('privacy');
  } catch(error) {
    next(error);
  }
})

app.get('/slackappsupport', async (req, res, next) => {
  try {
    res.render('support');
  } catch(error) {
    next(error);
  }
})


// TODO(tjohns): Figure out how to specify query parameter allowed values w/TypeScript
app.get('/auth', async (req, res, next) => {

  try {

    if (req.query.error) {
      console.warn(`Auth failed: ${req.query.error}`);
      res.redirect(`/authfailed?${qs.stringify({error: req.query.error})}`);
      return;
    }

    const userPass = `${process.env.SLACK_CLIENT_ID}:${await getSecret('slack_client_secret')}`;
    const basicCredentials = Buffer.from(userPass).toString('base64');
    // TODO(tjohns): Verify something here (in addition to just saving off the API Key)
    const decipher = await createDecipher();
    const stateTokenStr = decipher.update(req.query.state as string, 'base64', 'utf8') + decipher.final('utf8');

    // TODO(tjohns): Create a type for the StateToken
    let stateToken = JSON.parse(stateTokenStr);

    // TODO(tjohns): Remove this log statement
    console.log(stateTokenStr);

    const exchangeResponse = await axios(
      {
      method: 'post',
      url: 'https://slack.com/api/oauth.v2.access',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicCredentials}`
      },
      data: qs.stringify({
        code: req.query.code
      })
    });

    // TODO(tjohns) Remove this log statement.
    console.log(JSON.stringify({exchangeResponse: exchangeResponse.data}));

    if (stateToken.apiKey) {

      // The installer provided an API Key, so we will use it.

      // re-encrypt the API key
      const cipher = await createCipher();
      let encryptedAPIKey = cipher.update(stateToken.apiKey as string, 'utf8', 'base64') + cipher.final('base64');

      const slackUserKey = datastore.key(["SlackUser", exchangeResponse.data.authed_user.id]);
      const slackUser = {
        key: slackUserKey,
        data: {
          user: exchangeResponse.data.authed_user,
          apiKey: encryptedAPIKey
        }
      };
      // Save the user info (including the API Key for the user)
      const result = await datastore.save(slackUser);

      // TODO(tjohns): Remove this
      console.log(`Saved slackUser: ${JSON.stringify({slackUser})}.`);
      console.log(`Saved slackUser result: ${JSON.stringify({result})}.`);

    } // else the installer did NOT provide an API key, and will therefore remain
      // anonymous, and we'll (ultimately) use OUR API key to make the CheckPhish requests

    let teamName = "Team";
    if (exchangeResponse
      && exchangeResponse.data
      && exchangeResponse.data.team
      && exchangeResponse.data.team.name) {
        teamName = exchangeResponse.data.team.name;
      }

    // TODO(tjohns): Provide some context on how the installation was handled;
    // in other words, let the user know which of these scenarios they're in:
    //   Installed with no API token specified
    //      With the default token only
    //      With an existing team-wide token
    //   Installed with an individual API token specified
    //   Installed with a team-wide API token specified
    //      With an existing team-wide API token
    //      With the specified token now used for tean-wide access
    // Provide the user some instruction on how to fix what they did, if
    // it wasn't what they intended.
    res.redirect(`/authsuccess?${qs.stringify({teamName})}`);

  } catch(error) {
    next(error);
  }
});

app.get('/authsuccess', async (req, res, next) => {
  try {
    res.render('authsuccess', {team: req.query.teamName || "Unknown Team"});
  } catch(error) {
    next(error);
  }
});

app.get('/authfailed', async (req, res, next) => {
  try {
    res.render('authfailed', {error: req.query.error || "Unknown Error"});
  } catch(error) {
    next(error);
  }
});



// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});

module.exports = app;
