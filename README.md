# checkphish-slack-app
Simple Node Slack App for integrating the CheckPhish API with Slack, using Google App Engine, Google Pub/Sub, and Google Cloud Secret Manager.

## Table of Contents
Optionally, include a table of contents in order to allow other people to quickly navigate especially long or detailed READMEs.

## Installation
### Google Cloud Project Installation
1. Create a Project in the Google Cloud Console (ex. `checkphish-slack-app-dev`)
TODO(tjohns): GIF/Video

2. Initalize the GCloud Command Line Tools
- `gcloud init`
- Select [2] Create a new configuration
- Give the configuration a name (it may be convenient to name it the same as the project, i.e. `checkphish-slack-app-dev`)
- Choose the Google Cloud account you want to use
- Choose the Google Cloud project you created in step 1 (ex. `checkphish-slack-app-dev`)

3. Deploy using `gloud app deploy`. Note that you'll be deploying with a placeholder for the Slack App Client ID, which you'll need to update after configuring the Slack App (see Slack App Installation, below), and the state token cipher initialization vector, which you will generate later. Choose the region for your deployment (e.g. `us-central`).

4. Give the service account secretmanager.versions.access permission.
- "IAM & Admin"->"IAM"
- Find the service account (e.g. "checkphish-slack-app-dev@appspot.gserviceaccount.com") and select the edit icon to the right
- Under 'Role', select "Secret Manager Secret Accessor"


### Slack App Installation
1. Got to https://api.slack.com/apps
2. Select "Create New App"
3. Enter the name you want to use in "App Name" (e.g. "CheckPhish (Dev)")
4. Select the Development Slack Workspace you'll be developing and integrating in.
5. Select 'Create App'
6. Click 'Slash Commands' under 'Add features and functionality'
7. Click 'Create New Command'
8. Enter the name and other parameters. The 'request URL' will be the target URL from your Google Cloud Project App Engine installation, above (e.g. `https://checkphish-slack-app-dev.uc.r.appspot.com`)


### Secrets and Client ID Configuration
1. Generate a 128bit (16 byte) initialization vector (random data) for the state token encryption, and then encode it as a Base64 string. If the data length and encoding are correct, the string should be 24 characters long.
2. Copy the base64 IV string into the app.yaml file's STATE_TOKEN_CIPHER_IV value
3. Find the "App Credentials" under the "Basic Information" settings for your Slack command TODO(tjohns): Better GIF or Video
4. Copy the Client ID into your app.yaml file where indicated.
5. In your Google Cloud Project, select 'Security'->'Secret Manager'
6. Enable the Secret Manager API by clicking 'Enable' if it is not already enabled. Note: You may wish to review pricing.
7. Click 'CREATE SECRET' to create the first of five secrets used by the App.
8. Name the first secret 'slack_client_secret', and copy the value from your Slack App Client Secret.
9. Click 'Create Secret'.
10. Return to the Secret Manager parent page.
11. Click 'CREATE SECRET' to create the second secret.
12. Name the second secret 'slack_signing_secret', and copy the value from your Slack App Signing Secret.
13. Click 'Create Secret'.
14. Return to the Secret Manager parent page.
15. Click 'CREATE SECRET' to create the third secret.
16. Name the third secret 'default_checkphish_api_key', and copy the value from your CheckPhish API configuration.
17. Click 'Create Secret'.
18. Return to the Secret Manager parent page.
15. Click 'CREATE SECRET' to create the fourth secret.
16. Name the fourth secret 'state_token_cipher_key'.
17. Generate a 256bit (32 byte) key (cryptographically secure random value), and then encode it as a Base64 string. If the data length and encoding are correct, the string should be 44 characters long.
17. Add the string and click 'Create Secret'.
18. Return to the Secret Manager parent page.
15. Click 'CREATE SECRET' to create the last secret.
16. Name the las secret 'user_api_key_cipher_key'.
17. Generate a 256bit (32 byte) key (cryptographically secure random value), and then encode it as a Base64 string. If the data length and encoding are correct, the string should be 44 characters long.
17. Add the string and click 'Create Secret'.
18. Redeploy your App Engine project with the updated YAML.

### Configure PubSub
1. TODO(tjohns): Set up the 'scan' Topic and Subscription


