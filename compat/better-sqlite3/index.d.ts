import { Database as BunDatabase } from "bun:sqlite";

export { Statement } from "bun:sqlite";

export declare class Database extends BunDatabase {
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

export default Database;
