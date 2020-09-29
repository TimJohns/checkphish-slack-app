# checkphish-slack-app
Simple Node Slack App for integrating the CheckPhish API with Slack, using Google App Engine, Google Pub/Sub, and Google Cloud Functions

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

3. Deploy using `gloud app deploy`. Note that you'll be deploying with a placeholder for the Slack App Client ID, which you'll need to update after configuring the Slack App (see Slack App Installation, below). Choose the region for your deployment (e.g. `us-central`).



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
1. Generate an initialization vector (random data) for the state token encryption  TODO(tjohns): Indicate encoding and length
2. Copy the IV into the app.yaml file's STATE_TOKEN_CIPHER_IV value
3. Enter the IV into the Environment Variables for the Google Cloud Function
4. Find the "App Credentials" under the "Basic Information" settings for your Slack command TODO(tjohns): Better GIF or Video
5. Copy the Client ID into your app.yaml file where indicated.
6. In your Google Cloud Project, select 'Security'->'Secret Manager'
7. Enable the Secret Manager API by clicking 'Enable' if it is not already enabled. Note: You may wish to review pricing.
8. Click 'CREATE SECRET' to create the first of three secrets used by the App.
9. Name the first secret 'slack_client_secret', and copy the value from your Slack App Client Secret.
10. Click 'Create Secret'. TODO(tjohns): Consider manually selecting the region.
11. Return to the Secret Manager parent page. TODO(tjohns): GIF or video
12. Click 'CREATE SECRET' to create the second secret.
13. Name the second secret 'slack_signing_secret', and copy the value from your Slack App Signing Secret.
14. Click 'Create Secret'. TODO(tjohns): Consider manually selecting the region.
15. Return to the Secret Manager parent page. TODO(tjohns): GIF or video
16. Click 'CREATE SECRET' to create the third secret.
17. Name the third secret 'default_checkphish_api_key', and copy the value from your CheckPhish API configuration.
18. Click 'Create Secret'. TODO(tjohns): Consider manually selecting the region.
19. Redeploy your App Engine project with the updated YAML TODO(tjohns): Is there a convenient way to update the environment variable without redeploying?

### Deploy the Google Cloud Function
1. From the Cloud Functions screen in your project in the Google Cloud Console, choose 'CREATE FUNCTION' TODO(tjohns): GIF or video. And/or command line.
2. Give your cloud function a name (e.g. 'scan')
3. Ensure that the 'Region' matches the region in which you deployed your App Engine configuration (i.e. `us-central`).
4. Under 'Trigger Type', choose Cloud Pub/Sub.
5. Click the drop-down list box 'Select a Cloud Pub/Sub topic', and select 'CREATE A TOPIC'
6. For the Topic ID, enter 'scan'
7. Select 'CREATE TOPIC'
TODO(tjohns): Address retry on failure
8. Expand 'VARIABLES, NETWORKING, AND ADVANCED SETTINGS'
9. Under 'Maximum function instances', enter 1 (Note: This is personal preference, as I like to have limits on autoscaling)
10. Under 'Connections'->'Ingress settings', select 'Allow internal traffic only'
11. Click 'NEXT' to move to the Code page.
12. On the Code page, enter 'checkphishScan' for the entry point name.
TODO(tjohns): Convert these instructions to use the zip upload.
13. Copy-and-paste the index.js and package.json from the checkphish-slack-app-scan-gcf project.
14. Press 'DEPLOY'
15. You may be instructed to add the iam.serviceAccountUser role, for which the console will provide a command line you can run from your project configuration, but it probably means you need to refresh the browser (there appears to be a bug/stale state in the Angular app)
16. Give the service account secretmanager.versions.access permission.
- "IAM & Admin"->"IAM"
- Find the service account (e.g. "checkphish-slack-app-dev@appspot.gserviceaccount.com") and select the edit icon to the right
- Under 'Role', select "Secret Manager Secret Accessor"


