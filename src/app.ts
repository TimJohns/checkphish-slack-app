'use strict';

import { default as express, Request, Response } from "express";
import path from "path";

import bodyParser from "body-parser";
import { createSecretsCache } from "./secrets";
import { createAuthController } from "./authController";
import { createSlackAppController } from "./slackAppController";


const secrets = createSecretsCache();
const authController = createAuthController(secrets);
const slackAppController = createSlackAppController(secrets);

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


app.get('/slackappinstall', authController.handleGETInstall);
app.post('/slackappinstall', authController.handlePOSTInstall)
app.get('/auth', authController.handleGETAuth);
app.get('/authsuccess', authController.handleGETAuthSuccess);
app.get('/authfailed', authController.handleGETAuthFailed);

app.post('/', slackAppController.handlePOSTSlashCommand);


// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});

module.exports = app;
