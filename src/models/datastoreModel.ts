import { PathType } from "@google-cloud/datastore";

export interface DatastoreModel {
  getKeyPath(): PathType[];
  getData(): any;
};
