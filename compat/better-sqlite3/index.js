import { Database as BunDatabase } from "bun:sqlite";

export class Database extends BunDatabase {
  prepare(source) {
    const statement = super.prepare(source);
    return new Proxy(statement, {
      get(target, property) {
        if (property === "get") {
          return (...parameters) => target.get(...parameters) ?? undefined;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  pragma(source, options) {
    const statement = this.query(`PRAGMA ${source}`);
    return options?.simple ? statement.values()[0]?.[0] : statement.all();
  }
}

export default Database;
