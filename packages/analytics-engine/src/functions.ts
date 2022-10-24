import { SqliteDB } from "@miniflare/shared";

// https://github.com/ClickHouse/ClickHouse/blob/master/src/Common/IntervalKind.cpp#L13
const TIME = {
  SECOND: 1,
  MINUTE: 60, // 60sec
  HOUR: 3600, // 60sec * 60min
  DAY: 86400, // 60sec * 60min * 24hours
  MONTH: 2_629_746, // Exactly 1/12 of a year
  YEAR: 31_556_952, // The average length of a Gregorian year is equal to 365.2425 days
};

export default function buildSQLFunctions(sqliteDB: SqliteDB) {
  // return array as string
  sqliteDB.aggregate("__GET_QUANTILE_GROUP", {
    start: () => [],
    step: (array, nextValue) => {
      // if Date object, get UTC number
      if (typeof nextValue === "string") {
        nextValue = new Date(nextValue).getTime();
      }
      // store
      array.push(nextValue);
    },
    result: (array) => JSON.stringify(array),
  });
  // https://clickhouse.com/docs/en/sql-reference/aggregate-functions/reference/quantileexactweighted/
  // https://github.com/ClickHouse/ClickHouse/blob/master/src/AggregateFunctions/QuantileExactWeighted.h
  // 1) threshold = SUM(weights) * q.
  // 2) store arr as [[expr1, weight1], [expr2, weight2], ...].
  // 3) sort arr by expr value (smallest first).
  // 4) iterate arr, add each weight to an (accumulated = 0).
  //    if (accumulated >= threshold) return current expr.
  //    else return last expr.
  sqliteDB.function(
    "QUANTILEWEIGHTED",
    { varargs: true },
    (q = 0.5, expr: string, weight: string): number => {
      q = Math.min(Math.max(q, 0.01), 0.99);
      let store = [];
      const exprParsed = JSON.parse(expr) as number[];
      const weightParsed = JSON.parse(weight) as number[];
      const threshold = weightParsed.reduce((sum, value) => sum + value, 0) * q;
      // merge
      for (let i = 0, cl = exprParsed.length; i < cl; i++) {
        store.push([exprParsed[i], weightParsed[i]]);
      }
      // sort
      store = store.sort((a, b) => a[0] - b[0]);

      // iterate until accum is greater or equal to threshold. Return expr
      let accumulated = 0;
      for (const [expr, weight] of store) {
        accumulated += weight;
        if (accumulated >= threshold) return expr;
      }
      return store[store.length - 1][0];
    }
  );
  // https://clickhouse.com/docs/en/sql-reference/functions/conditional-functions/#if
  sqliteDB.function(
    "IF",
    (condition: 0 | 1, trueExpression: any, falseExpression: any): string => {
      if (condition === 0) return falseExpression;
      return trueExpression;
    }
  );
  // https://clickhouse.com/docs/en/sql-reference/functions/arithmetic-functions/#intdiva-b
  sqliteDB.function("INTDIV", (a: number, b: number) => {
    return Math.floor(a / b);
  });
  // https://clickhouse.com/docs/en/sql-reference/functions/type-conversion-functions/#touint8163264256
  sqliteDB.function(
    "TOUINT32",
    (input: string | number | Date): number | undefined => {
      // this will resolve both string and number
      if (!isNaN(input as any)) return parseInt(input as string);
      if (typeof input === "string" && isDate(input)) {
        return new Date(input).getTime() / 1000;
      }
      return undefined;
    }
  );
  // https://clickhouse.com/docs/en/sql-reference/functions/type-conversion-functions/#todatetime
  sqliteDB.function("TODATETIME", (input: string | number): string => {
    return new Date(input).toLocaleString("se-SE", { timeZone: "UTC" });
  });
  // https://clickhouse.com/docs/en/sql-reference/functions/date-time-functions/#now
  sqliteDB.function("NOW", (timeZone = "UTC"): string => {
    return new Date().toLocaleString("se-SE", { timeZone });
  });
  // NOTE: sqlite does NOT support PROCEDURE creation, so statements are preparsed
  // and "INTERVAL X Y" is converted to "INTERVAL(X, Y)"
  // https://clickhouse.com/docs/en/sql-reference/data-types/special-data-types/interval
  sqliteDB.function(
    "INTERVAL",
    (
      intervalValue: string | number,
      intervalType: keyof typeof TIME
    ): number | null => {
      if (typeof intervalValue === "string") {
        intervalValue = parseInt(intervalValue);
      }
      const multiplier = TIME[intervalType];
      if (multiplier === undefined) return null;
      return intervalValue * multiplier;
    }
  );
}

export function isDate(input: string): boolean {
  return (
    new Date(input).toString() !== "Invalid Date" && !isNaN(Date.parse(input))
  );
}
