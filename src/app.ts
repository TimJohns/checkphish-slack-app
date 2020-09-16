'use strict';

import { default as express, Request, Response, NextFunction } from "express";
import path from "path";

import bodyParser from "body-parser";
import { createSecretsCache } from "./secrets";
import { createAuthController, AuthController } from "./authController";
import { createSlackAppController, SlackAppController } from "./slackAppController";

declare var process : {
  env: {
    PORT: number
  }
}

class CheckPhishSlackApp {
  private app: any;
  private authController: AuthController;
  private slackAppController: SlackAppController;
  private port: number;

  constructor(app: any, authController: AuthController, slackAppController: SlackAppController) {
    this.app = app;
    this.authController = authController;
    this.slackAppController = slackAppController;
    this.port = process.env.PORT || 8080;
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

    app.set( "views", path.join( __dirname, "views" ) );
    app.set('view engine', 'ejs');

    app.get('/slackappprivacy', async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.render('privacy');
      } catch(error) {
        next(error);
      }
    })

    app.get('/slackappsupport', async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.render('support');
      } catch(error) {
        next(error);
      }
    })


    app.get('/slackappinstall', async (req: Request, res: Response, next: NextFunction) => {
      try {
        return authController.handleGETInstall(req, res);
      } catch(error) {
        next(error);
      }
    });
    app.post('/slackappinstall', async (req: Request, res: Response, next: NextFunction) => {
      try {
        return authController.handlePOSTInstall(req, res);
      } catch(error) {
        next(error);
      }
    });
    app.get('/auth', async (req: Request, res: Response, next: NextFunction) => {
      try {
        return authController.handleGETAuth(req, res);
      } catch(error) {
        next(error);
      }
    });
    app.get('/authsuccess', async (req: Request, res: Response, next: NextFunction) => {
      try {
        return authController.handleGETAuthSuccess(req, res);
      } catch(error) {
        next(error);
      }
    });
    app.get('/authfailed', async (req: Request, res: Response, next: NextFunction) => {
      try {
        return authController.handleGETAuthFailed(req, res);
      } catch(error) {
        next(error);
      }
    });

    app.post('/', async (req: Request, res: Response, next: NextFunction) => {
      try {
        return slackAppController.handlePOSTSlashCommand(req, res);
      } catch(error) {
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
  const authController = createAuthController(secrets);
  const signingSecret = await secrets.getSecret('slack_signing_secret');
  const slackAppController = createSlackAppController(signingSecret);

  return new CheckPhishSlackApp(app, authController, slackAppController);
}

init().then((checkPhishSlackApp) => {
  checkPhishSlackApp.setupExpress();
});
