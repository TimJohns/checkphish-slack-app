import defaultAxios, { AxiosInstance } from "axios";
import qs from "qs";
import crypto from "crypto";
import { Request, Response } from "express";
import { Datastore } from "@google-cloud/datastore";
import { SlackUserData, SlackUserModel } from "./models/slackUserModel";
import { CSRFTokenData, CSRFTokenModel } from "./models/csrfTokenModel";

const API_KEY_IV_LENGTH = 16;
const CSRF_TOKEN_LENGTH = 16;
const CSRF_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const SLACK_SLASH_COMMAND = process.env.SLACK_SLASH_COMMAND;

export interface AuthController {
  handleGETInstall(req: Request, res: Response): Promise<void>;
  handlePOSTInstall(req: Request, res: Response): Promise<void>;
  handleGETAuth(req: Request, res: Response): Promise<void>;
  handleGETAuthSuccess(req: Request, res: Response): Promise<void>;
  handleGETAuthFailed(req: Request, res: Response): Promise<void>;
};

export type AuthControllerParams = {
  slackClientId: string,
  slackClientSecret: string,
  stateTokenCipherKey: Buffer,
  stateTokenCipherIV: Buffer,
  userAPIKeyCipherKey: Buffer,
  axios?: AxiosInstance
};

export function createAuthController(params: AuthControllerParams) {
  const datastore = new Datastore();
  return new AuthControllerImpl(params, datastore);
};

type StateToken = {
  csrfToken: string,
  apiKey?: string
};

class AuthControllerImpl implements AuthController {
  private slackClientId: string;
  private slackClientSecret: string;
  private stateTokenCipherKey: Buffer;
  private stateTokenCipherIV: Buffer;
  private userAPIKeyCipherKey: Buffer;
  private datastore: Datastore;
  private axios: AxiosInstance;

  constructor(
    params: AuthControllerParams,
    datastore: Datastore
    ) {
      this.slackClientId = params.slackClientId;
      this.slackClientSecret = params.slackClientSecret;
      this.stateTokenCipherKey = params.stateTokenCipherKey;
      this.userAPIKeyCipherKey = params.userAPIKeyCipherKey;
      this.stateTokenCipherIV = params.stateTokenCipherIV;
      this.axios = params.axios || defaultAxios;
      this.datastore = datastore;
  };

  private async createStateTokenCipher(): Promise<crypto.Cipher> {

    const key = this.stateTokenCipherKey;
    const algorithm = 'aes-256-cbc';
    const iv = this.stateTokenCipherIV;

    return crypto.createCipheriv(algorithm, key, iv);
  };

  private async createStateTokenDecipher(): Promise<crypto.Decipher> {

    const key = this.stateTokenCipherKey;
    const algorithm = 'aes-256-cbc';
    const iv = this.stateTokenCipherIV;

    return crypto.createDecipheriv(algorithm, key, iv);
  };

  private async createUserAPIKeyCipher(iv: crypto.BinaryLike): Promise<crypto.Cipher> {

    const key = this.userAPIKeyCipherKey;
    const algorithm = 'aes-256-cbc';

    return crypto.createCipheriv(algorithm, key, iv);
  };

  private async generateCSRFToken(): Promise<string> {
    const datastore = this.datastore;
    const csrfTokenHexStr = crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex');

    const csrfTokenData: CSRFTokenData = {
      timestamp: Date.now()
    };

    const csrfToken = new CSRFTokenModel({
      csrfTokenHexStr,
      csrfTokenData
    });

    // Save the csrf token info (including the timestamp)
    await datastore.save({
      key: datastore.key(csrfToken.getKeyPath()),
      data: csrfToken.getData()
    });

    return csrfTokenHexStr;
  }

  private async validateCSRFToken(csrfTokenHexStr: string) {
    const datastore = this.datastore;

    if (!csrfTokenHexStr
      || !csrfTokenHexStr.length) {
      console.warn(`No CSRF token.`);
      const error = new Error('CSRF token not found.');
      error.statusCode = 401;
      throw error;
    }


    const csrfToken = new CSRFTokenModel({csrfTokenHexStr});
    const csrfTokenKey = datastore.key(csrfToken.getKeyPath());

    const query = datastore
      .createQuery()
      .filter('__key__', csrfTokenKey)
      .limit(1);

    const [[csrfTokenData]] = await datastore.runQuery(query);

    if (!csrfTokenData
      || !csrfTokenData.timestamp) {
      console.warn(`CSRF token ${csrfTokenHexStr} not found.`);
      const error = new Error('CSRF token not found.');
      error.statusCode = 401;
      throw error;
    }

    const now = Date.now();
    if (now - csrfTokenData.timestamp > CSRF_TOKEN_LIFETIME_MS) {
      console.warn(`CSRF token ${csrfTokenHexStr} expired at ${csrfTokenData.timestamp}ms. Currently ${now}ms.`);
      const error = new Error('CSRF token expired.');
      error.statusCode = 401;
      throw error;
    }

    datastore.delete(csrfTokenKey);
  }

  async handleGETInstall(req: Request, res: Response) {
    res.render('install', {
      csrfToken: await this.generateCSRFToken(),
      slackSlashCommand: SLACK_SLASH_COMMAND
    });
  };

  async handlePOSTInstall(req: Request, res: Response) {

    // Verify CSRF token
    await this.validateCSRFToken(req.body.csrftoken as string);

    let destUrl = `https://slack.com/oauth/v2/authorize?client_id=${this.slackClientId}&scope=commands&user_scope=`;
    const apiKey = (req.body.apiKey || '').trim()
    const stateToken: StateToken = {
      csrfToken: await this.generateCSRFToken()
    };

    if (apiKey.length) {
      stateToken.apiKey = apiKey;
    }

    // TODO(tjohns): Allow the user to make a trial request with the API key to verify it's
    // valid (at that one moment, anyway)

    const stateTokenStr = JSON.stringify(stateToken);
    // Encrypt the state token
    const cipher = await this.createStateTokenCipher();
    const encryptedStateToken = cipher.update(stateTokenStr, 'utf8', 'base64') + cipher.final('base64');

    destUrl += "&state=" + encodeURIComponent(encryptedStateToken);

    res.redirect(destUrl);
  };

  // TODO(tjohns): Figure out how to specify query parameter allowed values w/TypeScript
  async handleGETAuth(req: Request, res: Response) {
    const datastore = this.datastore;
    const axios = this.axios;

    if (req.query.error) {
      console.warn(`Auth failed: ${req.query.error}`);
      res.redirect(`/authfailed?${qs.stringify({error: req.query.error})}`);
      return;
    }

    const userPass = `${this.slackClientId}:${this.slackClientSecret}`;
    const basicCredentials = Buffer.from(userPass).toString('base64');
    const decipher = await this.createStateTokenDecipher();
    const stateTokenStr = decipher.update(req.query.state as string, 'base64', 'utf8') + decipher.final('utf8');

    const stateToken: StateToken = JSON.parse(stateTokenStr);

    // Validate the CSRF token in the state token
    await this.validateCSRFToken(stateToken.csrfToken);

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

    const slackUserData: SlackUserData = {
      user: exchangeResponse.data.authed_user,
      team: exchangeResponse.data.team,
    };

    if (stateToken.apiKey) {

      // The installer provided an API Key, so we will use it.

      // re-encrypt the API key, using a per-user IV
      slackUserData.apiKeyIV = crypto.randomBytes(API_KEY_IV_LENGTH);
      const cipher = await this.createUserAPIKeyCipher(slackUserData.apiKeyIV);
      slackUserData.apiKey = cipher.update(stateToken.apiKey, 'utf8', 'base64') + cipher.final('base64');

    } // else the installer did NOT provide an API key, and will therefore remain
      // anonymous, and we'll (ultimately) use OUR API key to make the CheckPhish requests

    const slackUser = new SlackUserModel({
      teamId: slackUserData.team.id,
      userId: slackUserData.user.id,
      userData: slackUserData
    });

    // Save the user info (including the API Key for the user)
    const result = await datastore.save({
      key: datastore.key(slackUser.getKeyPath()),
      data: slackUser.getData()
    });


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
    res.redirect(`/authsuccess?${qs.stringify({teamName: exchangeResponse.data.team.name})}`);

  };

  async handleGETAuthSuccess(req: Request, res: Response) {
    res.render('authsuccess', {
      team: req.query.teamName || "Unknown Team",
      slackSlashCommand: SLACK_SLASH_COMMAND
    });
  };

  async handleGETAuthFailed(req: Request, res: Response) {
    res.render('authfailed', {error: req.query.error || "Unknown Error"});
  };

}