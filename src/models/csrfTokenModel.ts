import { PathType } from "@google-cloud/datastore";
import { DatastoreModel } from "./datastoreModel";

export type CSRFTokenData = {
  timestamp: number
};

export class CSRFTokenModel implements DatastoreModel {
  private csrfTokenKeyName: string;
  private csrfTokenData: CSRFTokenData;
  constructor(params: {csrfTokenHexStr: string, csrfTokenData?: CSRFTokenData}) {
    this.csrfTokenKeyName = params.csrfTokenHexStr;
    this.csrfTokenData = params.csrfTokenData;
  }

  getKeyPath(): PathType[] {
    return ['CSRFToken', this.csrfTokenKeyName];
  }

  getData(): any {
    return this.csrfTokenData;
  }
}


