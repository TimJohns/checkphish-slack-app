'use strict';

import { default as express, Request, Response, NextFunction } from "express";
import path from "path";

import bodyParser from "body-parser";
import { createSecretsCache } from "./secrets";
import { createAuthController, AuthController } from "./authController";
import { createSlackAppController, SlackAppController } from "./slackAppController";
import { createPubSubController, PubSubController } from "./pubsubController";

declare var process : {
  env: {
    PORT: number,
    SLACK_CLIENT_ID: string,
    STATE_TOKEN_CIPHER_IV: string,
    PUBSUB_SUBSCRIPTION_AUDIENCE: string
  }
}

class CheckPhishSlackApp {
  private app: any;
  private authController: AuthController;
  private slackAppController: SlackAppController;
  private pubSubController: PubSubController;
  private port: number;

  constructor(
    app: any,
    authController: AuthController,
    slackAppController: SlackAppController,
    pubSubController: PubSubController) {
    this.app = app;
    this.authController = authController;
    this.slackAppController = slackAppController;
    this.port = process.env.PORT || 8080;
    this.pubSubController = pubSubController;
  }

  setupExpress() {
    const app = this.app;
    const authController = this.authController;
    const slackAppController = this.slackAppController;
    const port = this.port;

    // Note that verifyURLEncodedBody must be safe to call on EVERY request. We're lucky that the
    // logic here is simple - if there is a request signature header from Slack, verify it.
    function verifyURLEncodedBody(req: Request, res: Response, buf: Buffer, encoding: BufferEncoding) {
      if (req.header('x-slack-signature')) {
        slackAppController.verifyURLEncodedBody(req, buf, encoding);
      }
    }

    app.use(bodyParser.urlencoded({ extended: true, verify: verifyURLEncodedBody}));
    app.use(bodyParser.json());

    app.set( "views", path.join( __dirname, "views" ) );
    app.set('view engine', 'ejs');

    app.use( express.static( path.join( __dirname, "public" ) ) );

    app.get('/_ah/warmup', (req: Request, res: Response) => {
      // We don't actually need to DO anything here, currently, but we must handle this request
      // in order for GCP App Engine to pay attention to our min_instances in app.yaml.
      res.sendStatus(200);
    });

    app.get('/slackappprivacy', async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.render('privacy');
      } catch(error) {
        next(error);
      }
    });
    app.get('/slackappsupport', async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.render('support');
      } catch(error) {
        next(error);
      }
    });
    app.get('/slackappinstall', async (req: Request, res: Response, next: NextFunction) => {
      try {
        await authController.handleGETInstall(req, res);
      } catch(error) {
        next(error);
      }
    });
    app.post('/slackappinstall', async (req: Request, res: Response, next: NextFunction) => {
      try {
        await authController.handlePOSTInstall(req, res);
      } catch(error) {
        next(error);
      }
    });
    app.get('/auth', async (req: Request, res: Response, next: NextFunction) => {
      try {
        await authController.handleGETAuth(req, res);
      } catch(error) {
        next(error);
      }
    });
    app.get('/authsuccess', async (req: Request, res: Response, next: NextFunction) => {
      try {
        await authController.handleGETAuthSuccess(req, res);
      } catch(error) {
        next(error);
      }
    });
    app.get('/authfailed', async (req: Request, res: Response, next: NextFunction) => {
      try {
        await authController.handleGETAuthFailed(req, res);
      } catch(error) {
        next(error);
      }
    });

    app.post('/slackappslashcmd', async (req: Request, res: Response, next: NextFunction) => {
      try {
        await slackAppController.handlePOSTSlashCommand(req, res);
      } catch(error) {
        next(error);
      }
    });

    app.post('/pubsub/push', async (req: Request, res: Response, next: NextFunction) => {
      try {
        await this.pubSubController.handlePOSTPubSubPush(req, res);
      } catch(error) {
        console.error(`Error handling PubSub Push POST request: ${error}`);
        next(error);
      }
    });

    // Start the server
    app.listen(port, () => {
      console.log(`App listening on port ${port}`);
      console.log('Press Ctrl+C to quit.');
    });
  };
};

async function init() {

  const app = express();
  const secrets = createSecretsCache();
  const userAPIKeyCipherKey = await secrets.getSecret('user_api_key_cipher_key');

  const authController = createAuthController({
    slackClientId: process.env.SLACK_CLIENT_ID,
    slackClientSecret: await secrets.getSecret('slack_client_secret'),
    stateTokenCipherKey: await secrets.getSecret('state_token_cipher_key'),
    stateTokenCipherIV: process.env.STATE_TOKEN_CIPHER_IV,
    userAPIKeyCipherKey
  });
  const signingSecret = await secrets.getSecret('slack_signing_secret');
  const slackAppController = createSlackAppController(signingSecret);
  const pubSubController = createPubSubController({
    defaultCheckPhishAPIKey: await secrets.getSecret('checkphish_api_key'),
    audience: process.env.PUBSUB_SUBSCRIPTION_AUDIENCE,
    userAPIKeyCipherKey
  });

  return new CheckPhishSlackApp(app, authController, slackAppController, pubSubController);
}

init().then((checkPhishSlackApp) => {
  checkPhishSlackApp.setupExpress();
});
