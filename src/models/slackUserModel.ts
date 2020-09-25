import { PathType } from "@google-cloud/datastore";

// TODO(tjohns): Move DatastoreModel to a different file
export interface DatastoreModel {
  getKeyPath(): PathType[];
  getData(): any;
};

export type SlackUserData = {
  // TODO(tjohns): user is not really 'any', it's Slack's type. Use that type or create a bounded context
  user: any,
  // TODO(tjohns): team is not really 'any', it's Slack's type. Use that type or create a bounded context
  team: any,
  // TODO(tjohns): apiKey and apiKeyIV don't really belong to the Slack User (and therefore
  // probably not in this model...)
  apiKey?: string
  apiKeyIV?: Buffer
};

export class SlackUserModel implements DatastoreModel {
  private userKeyName: string;
  private userData: SlackUserData;
  constructor(params: {teamId: string, userId: string, userData?: SlackUserData}) {
    // Per https://api.slack.com/methods/users.identity:
    //
    // User IDs are not guaranteed to be globally unique across all Slack users. The combination
    // of user ID and team ID, on the other hand, is guaranteed to be globally unique.
    //
    // Therefore, we're going to create our key by concatenating the two.
    this.userKeyName = `${params.teamId}.${params.userId}`;
    this.userData = params.userData;
  }

  getKeyPath(): PathType[] {
    return ['SlackUser', this.userKeyName];
  }

  getData(): any {
    return this.userData;
  }
}


