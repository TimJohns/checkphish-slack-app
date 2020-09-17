import axios from "axios";
import qs from "qs";
import crypto from "crypto";
import { Request, Response } from "express";
import { Datastore } from "@google-cloud/datastore";

export interface AuthController {
  // TODO(tjohns): Figure out what these returned promises actually SHOULD be (not 'any', most likely)
  handleGETInstall(req: Request, res: Response): Promise<any>;
  handlePOSTInstall(req: Request, res: Response): Promise<any>;
  handleGETAuth(req: Request, res: Response): Promise<any>;
  handleGETAuthSuccess(req: Request, res: Response): Promise<any>;
  handleGETAuthFailed(req: Request, res: Response): Promise<any>;
};

export type AuthControllerParams = {
  slackClientId: string,
  slackClientSecret: string,
  stateTokenCipherKey: string,
  stateTokenCipherIV: string
};

export function createAuthController(params: AuthControllerParams) {
  const datastore = new Datastore();
  return new AuthControllerImpl(params, datastore);
};

class AuthControllerImpl implements AuthController {
  private slackClientId: string;
  private slackClientSecret: string;
  private stateTokenCipherKey: string;
  private stateTokenCipherIV: string;
  private datastore: Datastore;

  constructor(
    params: AuthControllerParams,
    datastore: Datastore
    ) {
      this.slackClientId = params.slackClientId;
      this.slackClientSecret = params.slackClientSecret;
      this.stateTokenCipherKey = params.stateTokenCipherKey;
      this.stateTokenCipherIV = params.stateTokenCipherIV;
      this.datastore = datastore;
  };

  private async createCipher(): Promise<crypto.Cipher> {

    const key = this.stateTokenCipherKey;
    const algorithm = 'aes-256-cbc';
    const iv = this.stateTokenCipherIV;

    return crypto.createCipheriv(algorithm, key, iv);
  };

  private async createDecipher(): Promise<crypto.Decipher> {

    const key = this.stateTokenCipherKey;
    const algorithm = 'aes-256-cbc';
    const iv = this.stateTokenCipherIV;

    return crypto.createDecipheriv(algorithm, key, iv);
  };


  async handleGETInstall(req: Request, res: Response) {
    // TODO(tjohns): Generate CSRF/OTP Session Token (nonce + timestamp + random)
    res.render('install');
  };

  async handlePOSTInstall(req: Request, res: Response) {

    // TODO(tjohns): Remove this console log
    console.log(JSON.stringify({body: req.body}));

    // TODO(tjohns) Pass 'SLACK_CLIENT_ID' in as a dependency
    let destUrl = `https://slack.com/oauth/v2/authorize?client_id=${this.slackClientId}&scope=commands&user_scope=`;
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

      const stateTokenStr = JSON.stringify(stateToken);
      // Encrypt the state token
      const cipher = await this.createCipher();
      const encryptedStateToken = cipher.update(stateTokenStr, 'utf8', 'base64') + cipher.final('base64');

      destUrl += "&state=" + encodeURIComponent(encryptedStateToken);
    }
    res.redirect(destUrl);
  };

  // TODO(tjohns): Figure out how to specify query parameter allowed values w/TypeScript
  async handleGETAuth(req: Request, res: Response) {
    const datastore = this.datastore;

    if (req.query.error) {
      console.warn(`Auth failed: ${req.query.error}`);
      res.redirect(`/authfailed?${qs.stringify({error: req.query.error})}`);
      return;
    }

    const userPass = `${this.slackClientId}:${this.slackClientSecret}`;
    const basicCredentials = Buffer.from(userPass).toString('base64');
    // TODO(tjohns): Verify something here (in addition to just saving off the API Key)
    const decipher = await this.createDecipher();
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
      const cipher = await this.createCipher();
      let encryptedAPIKey = cipher.update(stateToken.apiKey as string, 'utf8', 'base64') + cipher.final('base64');

      // Per https://api.slack.com/methods/users.identity:
      //
      // User IDs are not guaranteed to be globally unique across all Slack users. The combination
      // of user ID and team ID, on the other hand, is guaranteed to be globally unique.
      //
      // Therefore, we're going to create our key by concatenating the two.
      const slackUserKeyName = `${exchangeResponse.data.team.id}.${exchangeResponse.data.authed_user.id}`;
      const slackUserKey = datastore.key(["SlackUser", slackUserKeyName]);
      const slackUser = {
        key: slackUserKey,
        data: {
          user: exchangeResponse.data.authed_user,
          team: exchangeResponse.data.team,
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

  };

  async handleGETAuthSuccess(req: Request, res: Response) {
    res.render('authsuccess', {team: req.query.teamName || "Unknown Team"});
  };

  async handleGETAuthFailed(req: Request, res: Response) {
    res.render('authfailed', {error: req.query.error || "Unknown Error"});
  };

}