'use strict';

import { default as express, Request, Response, NextFunction } from "express";
import path from "path";

import bodyParser from "body-parser";
import { createSecretsCache, Secrets } from "./secrets";
import { createAuthController, AuthController } from "./authController";
import { createSlackAppController, SlackAppController } from "./slackAppController";

declare var process : {
  env: {
    PORT: number
  }
}

class CheckPhishSlackApp {
  private app: any;
  private secrets: Secrets;
  private authController: AuthController;
  private slackAppController: SlackAppController;
  private port: number;

  constructor(app: any, secrets: Secrets, authController: AuthController, slackAppController: SlackAppController) {
    this.app = app;
    this.secrets = secrets;
    this.authController = authController;
    this.slackAppController = slackAppController;
    this.port = process.env.PORT || 8080;
  }

  setupExpress() {
    const app = this.app;
    const authController = this.authController;
    const slackAppController = this.slackAppController;
    const port = this.port;

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


    app.get('/slackappinstall', authController.handleGETInstall);
    app.post('/slackappinstall', authController.handlePOSTInstall)
    app.get('/auth', authController.handleGETAuth);
    app.get('/authsuccess', authController.handleGETAuthSuccess);
    app.get('/authfailed', authController.handleGETAuthFailed);

    app.post('/', slackAppController.handlePOSTSlashCommand);


    // Start the server
    app.listen(port, () => {
      console.log(`App listening on port ${PORT}`);
      console.log('Press Ctrl+C to quit.');
    });
  };
};

async function init() {
  const app = express();
  const secrets = createSecretsCache();
  const authController = createAuthController(secrets);
  const slackAppController = createSlackAppController(secrets);

  return new CheckPhishSlackApp(app, secrets, authController, slackAppController);

}

init().then((checkPhishSlackApp) => {
  checkPhishSlackApp.setupExpress();
);