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

    // TODO(tjohns): Remove these console logs
    console.log(JSON.stringify({headers: req.headers}));
    console.log(JSON.stringify({scopes: req.headers['X-OAuth-Scopes']}));

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
        url,
        user_id: req.body.user_id,
        team_id: req.body.team_id,
        response_url: req.body.response_url
      };

      const dataBuffer = Buffer.from(JSON.stringify(message));
      await pubSubClient.topic('scan').publish(dataBuffer);
      res.status(200).json({
        response_type: 'ephemeral',
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
    // TODO(tjohns): Conditionally render the 'shareAPIKeyCheck' checkbox and
    // corresponding instructions only if no team-wide API token already exists.
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

      if (req.body.shareAPIKeyCheck == 'share') {
        stateToken.shareAPIKey = true;
      }

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

    const userPass = `${process.env.SLACK_CLIENT_ID}:${await getSlackClientSecret()}`;
    const basicCredentials = Buffer.from(userPass).toString('base64');

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
      let encryptedAPIKey = cipher.update(stateToken.apiKey, 'base64', 'base64') + cipher.final('base64');

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

      if (stateToken.shareAPIKey) {

        const query = datastore
        .createQuery('SlackTeam')
        .filter('__key__', datastore.key(['SlackTeam', exchangeResponse.data.team.id]));

        const [[slackTeam]] = await datastore.runQuery(query);

        // TODO(tjohns): Remove this
        console.log(`Retrieved slackTeam ${JSON.stringify({slackTeam})}.`);

        // TODO(tjohns): What's the feedback if a token already exists?
        if (!slackTeam || !slackTeam.apiKey) {

          // No Team found, create one (with the API key)
          // Inherent policy is that the FIRST API Key installed for a team becomes the default
          const slackTeamKey = datastore.key(["SlackTeam", exchangeResponse.data.team.id]);

          const slackTeam = {
            key: slackTeamKey,
            data: {
              team: exchangeResponse.data.team,
              apiKey: encryptedAPIKey
            },
          };

          // Save the team info (including the API Key for the team)
          await datastore.save(slackTeam);

          // TODO(tjohns): Remove this
          console.log(`Saved slackTeam: ${JSON.stringify({slackTeam})}.`);
        }
      }

    } // else the installer did NOT provide an API key, and will therefore remain
      // anonymous, and we'll (ultimately) use OUR API key to make the CheckPhish requests

    let teamName = "Team";
    if (exchangeResponse
      && exchangeResponse.data
      && exchangeResponse.data.team
      && exchangeResponse.data.team.name) {
          team = exchangeResponse.data.team.name;
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
