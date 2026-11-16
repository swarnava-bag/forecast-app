/**
 * Tests for the generic file consolidator core.  npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { consolidate, splitRecords, parseRecord } from "../lib/consolidate";

test("column names match ignoring case and spacing; low overlap is reported", () => {
  const r = consolidate([
    { name: "A.csv", text: "Item Code,Qty\nX,1\n" },
    { name: "B.csv", text: " item  code ,QTY\nY,2\n" },
    { name: "C.csv", text: "Foo,Bar\n9,9\n" },
  ]);
  assert.deepEqual(r.header, ["Item Code", "Qty", "Foo", "Bar"]);
  assert.equal(r.csv.split("\r\n")[2], "Y,2,,");
  assert.equal(r.reports[1].overlap, 1);
  assert.equal(r.reports[2].overlap, 0);
});

test("blank and comma-only rows are dropped", () => {
  const r = consolidate([{ name: "A.csv", text: "a,b\n1,2\n,,\n\n3,4\n" }]);
  assert.equal(r.totalRows, 2);
});

test("splitRecords handles quoted commas/newlines, CRLF, BOM, trailing newline", () => {
  const t = '﻿a,b\r\n1,"x, y"\n2,"line1\nline2"\n\n';
  assert.deepEqual(splitRecords(t), ["a,b", '1,"x, y"', '2,"line1\nline2"']);
});

test("parseRecord unescapes doubled quotes", () => {
  assert.deepEqual(parseRecord('a,"he said ""hi""",,c'), ["a", 'he said "hi"', "", "c"]);
});

test("same headers → header once, rows passed through verbatim", () => {
  const r = consolidate([
    { name: "A.csv", text: "Code,Qty\n`001,1.50\n" },
    { name: "B.csv", text: 'Code,Qty\r\n002,"2"\r\n003,3\r\n' },
  ]);
  assert.equal(r.totalRows, 3);
  assert.equal(r.csv, 'Code,Qty\r\n`001,1.50\r\n002,"2"\r\n003,3\r\n');
  assert.deepEqual(r.reports.map((x) => [x.rows, x.header]), [[1, "exact"], [2, "exact"]]);
});

test("re-ordered / extra / missing columns are realigned", () => {
  const r = consolidate([
    { name: "A.csv", text: "Code,Qty,Name\n1,10,x\n" },
    { name: "B.csv", text: "Qty,Code,Zone\n20,2,N\n" },
  ]);
  assert.deepEqual(r.header, ["Code", "Qty", "Name", "Zone"]);
  assert.equal(r.csv, "Code,Qty,Name,Zone\r\n1,10,x,\r\n2,20,,N\r\n");
  assert.deepEqual(r.reports[1].missing, ["Name"]);
  assert.deepEqual(r.reports[1].extra, ["Zone"]);
});

test("optional Source File column", () => {
  const r = consolidate(
    [{ name: "EZ BLR SO.csv", text: "a\n1\n" }, { name: "PMR SO.csv", text: "a\n2\n" }],
    { addSourceColumn: true },
  );
  assert.equal(r.csv, "a,Source File\r\n1,EZ BLR SO\r\n2,PMR SO\r\n");
});
