'use strict';

const express = require('express');
const {PubSub} = require('@google-cloud/pubsub');
const bodyParser = require('body-parser');
const {SecretManagerServiceClient} = require('@google-cloud/secret-manager');
const {verifyRequestSignature} = require('@slack/events-api');
const {GoogleAuth} = require('google-auth-library');
const axios = require('axios');
const qs = require('qs');
const crypto = require('crypto');
const {Datastore} = require('@google-cloud/datastore');

const pubSubClient = new PubSub();
const secretManagerServiceClient = new SecretManagerServiceClient();
const auth = new GoogleAuth();
const datastore = new Datastore();

const secrets = new Map();
async function getSecret(secretName) {
  let secret = secrets.get(secretName);

  if (!secret) {
    console.log(`No cached secret found, fetching ${secretName} from secret manager`);

    const projectId = await auth.getProjectId();

    const [accessResponse] = await secretManagerServiceClient.accessSecretVersion({
      name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
    });

    secret = accessResponse.payload.data.toString('utf8')
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
      signingSecret: await getSecret('slack_signing_secret'),
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
        url,
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

  try {
    let destUrl = `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=commands&user_scope=`;
    if (req.body.apiKey) {

      // TODO(tjohns): Verify CSRF token (I'm not sure this is strictly necessary, since the
      // apiKey is, in effect, a form of identity token, but I'm 100% certain if I DON'T
      // use a CSRF token, I'll have to explain that, since it's standard practice - and
      // of course I might be wrong!)

      // TODO(tjohns): Make a trial request with the API key to verify it's valid (at that one
      // moment, anyway)

      const stateToken = {
        apiKey: req.body.apiKey
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

    const userPass = `${process.env.SLACK_CLIENT_ID}:${await getSecret('slack_client_secret')}`;
    const basicCredentials = Buffer.from(userPass).toString('base64');
    // TODO(tjohns): Verify something here (in addition to just saving off the API Key)
    const decipher = await createDecipher();
    const stateTokenStr = decipher.update(req.query.state, 'base64', 'utf8') + decipher.final('utf8');

    let stateToken = JSON.parse(stateTokenStr);

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

    // TODO(tjohns): Validate response; If not 'ok', return a more meaningful error

    const teamKey = datastore.key(["SlackTeam", exchangeResponse.data.team.id]);

    // re-encrypt the API key
    const cipher = await createCipher();
    let encryptedAPIKey = cipher.update(stateToken.apiKey, 'base64', 'base64') + cipher.final('base64');

    const team = {
      key: teamKey,
      data: {
        team: exchangeResponse.data.team,
        apiKey: encryptedAPIKey
      },
    };

    // Save the team info (including the API Key for the team)
    await datastore.save(team);

    let teamName = "Team";
    if (exchangeResponse
      && exchangeResponse.data
      && exchangeResponse.data.team
      && exchangeResponse.data.team.name) {
        teamName = exchangeResponse.data.team.name;
      }

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
