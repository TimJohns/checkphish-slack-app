'use strict';

const express = require('express');
const {PubSub} = require('@google-cloud/pubsub');
const bodyParser = require('body-parser');
const {SecretManagerServiceClient} = require('@google-cloud/secret-manager');
const {verifyRequestSignature} = require('@slack/events-api');
const {GoogleAuth} = require('google-auth-library');
const axios = require('axios');
const qs = require('qs');

const pubSubClient = new PubSub();
const secretManagerServiceClient = new SecretManagerServiceClient();
const auth = new GoogleAuth();

let gSlackSigningSecret;
async function getSlackSigningSecret() {

  if (!gSlackSigningSecret) {

    console.log('No cached slack signing secret, fetching secret from secret manager');

    const projectId = await auth.getProjectId();

    // Access the secret.
    const [accessResponse] = await secretManagerServiceClient.accessSecretVersion({
      name: `projects/${projectId}/secrets/slack_signing_secret/versions/latest`,
    });

    gSlackSigningSecret = accessResponse.payload.data.toString('utf8');
  }
  return gSlackSigningSecret;
};

let gSlackClientSecret;
async function getSlackClientSecret() {

  if (!gSlackClientSecret) {

    console.log('No cached client secret, fetching secret from secret manager');

    const projectId = await auth.getProjectId();

    // Access the secret.
    const [accessResponse] = await secretManagerServiceClient.accessSecretVersion({
      name: `projects/${projectId}/secrets/slack_client_secret/versions/latest`,
    });

    gSlackClientSecret = accessResponse.payload.data.toString('utf8');
  }
  return gSlackClientSecret;
};

const app = express();

// TODO(tjohns): rawBodySaver, while a prolific hack, is still a hack
// Consider a PR for body-parser that leaves the rawBody in place, or
// make the 'verify' async
function rawBodySaver (req, res, buf, encoding) {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8')
  }
}

app.use(bodyParser.urlencoded({ extended: true, verify: rawBodySaver}));
app.set('view engine', 'ejs');

app.post('/', async (req, res, next) => {

  try {

    // Validate signature
    const signature = {
      signingSecret: await getSlackSigningSecret(),
      requestSignature: req.headers['x-slack-signature'],
      requestTimestamp: req.headers['x-slack-request-timestamp'],
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
        url: url,
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
  try {
    let destUrl = `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=commands&user_scope=`;
    if (req.body.apikey) {
      // TODO(tjohns): Verify CSRF token
      // TODO(tjohns): Encrypt provided API key using a secret stored in the Secret manager
      // TODO(tjohns): Include state=<encrypted value> on destUrl
    }
    res.redirect(destUrl);

  } catch(error) {
    next(error);
  }
})

app.get('/slackappprivacy', async (req, res, nex) => {
  try {
    res.render('privacy');
  } catch(error) {
    next(error);
  }
})

app.get('/slackappsupport', async (req, res, nex) => {
  try {
    res.render('support');
  } catch(error) {
    next(error);
  }
})


app.get('/auth', async (req, res, next) => {

  try {

    if (req.query.error) {
      console.warn(`Auth failed: ${req.query.error}`);
      res.redirect(`/authfailed?${qs.stringify({error: req.query.error})}`);
      return;
    }

    const userPass = `${process.env.SLACK_CLIENT_ID}:${await getSlackClientSecret()}`;
    const basicCredentials = Buffer.from(userPass).toString('base64');

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

    // TODO(tjohns): If 'ok':
    // Get the state token
    // Create a key-value store with the exchangeResponse.data.app_id (our App ID) and exchangeResponse.data.team.id (the workspace Id)
    // Store the state token (i.e. encrypted API key)
    let team = "Team";
    if (exchangeResponse
      && exchangeResponse.data
      && exchangeResponse.data.team
      && exchangeResponse.data.team.name) {
          team = exchangeResponse.data.team.name;
      }

    res.redirect(`/authsuccess?${qs.stringify({team})}`);

  } catch(error) {
    next(error);
  }
});

app.get('/authsuccess', async (req, res, next) => {
  try {
    res.render('authsuccess', {team: req.query.team || "Unknown Team"});
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
