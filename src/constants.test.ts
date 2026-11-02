import * as assert from "assert";
import {
  ConstantRef,
  constantRefAtPosition,
  extractConstants,
  isLocallyBound,
} from "./constants";
import { extractModuleImports } from "./typeDefinitions";

describe("extractConstants", () => {
  it("finds private and public constants, with or without annotation", () => {
    const source = [
      "const a = 1",
      "",
      "pub const b: ByteArray = #\"abcd\"",
      "",
      "pub fn c() {",
      "  const_like",
      "}",
    ].join("\n");

    assert.deepStrictEqual(extractConstants(source), [
      { name: "a", line: 0, isPublic: false, source: "const a = 1" },
      {
        name: "b",
        line: 2,
        isPublic: true,
        source: "pub const b: ByteArray = #\"abcd\"",
      },
    ]);
  });

  it("keeps values spanning several lines", () => {
    const list = ["const xs: List<Int> =", "  [", "    1,", "", "    2,", "  ]"];
    const record = ["pub const r = Foo {", "  a: 1,", "}"];
    const source = [...list, "", ...record, "", "const z = 1"].join("\n");

    assert.deepStrictEqual(
      extractConstants(source).map((c) => c.source),
      [list.join("\n"), record.join("\n"), "const z = 1"],
    );
  });

  it("is not fooled by brackets in strings and comments", () => {
    const source = ['const a = "{" // (', "const b = 1"].join("\n");
    assert.deepStrictEqual(
      extractConstants(source).map((c) => c.name),
      ["a", "b"],
    );
    assert.strictEqual(extractConstants(source)[0].source, 'const a = "{" // (');
  });

  it("ignores comments and indented lookalikes", () => {
    const source = ["// const a = 1", "  const b = 2"].join("\n");
    assert.deepStrictEqual(extractConstants(source), []);
  });
});

describe("constantRefAtPosition", () => {
  const imports = extractModuleImports(
    [
      "use config/fees.{base_fee, flat as flat_fee, Fee}",
      "use config/limits as lim",
    ].join("\n"),
  );

  // `|` marks the cursor, sitting right before the hovered character.
  function refAt(marked: string): ConstantRef | undefined {
    return constantRefAtPosition(marked.replace("|", ""), marked.indexOf("|"), imports);
  }

  it("reads a bare name as local, wherever the cursor is in it", () => {
    const expected = { kind: "local", name: "foo" };
    assert.deepStrictEqual(refAt("  |foo + 1"), expected);
    assert.deepStrictEqual(refAt("  f|oo + 1"), expected);
    assert.deepStrictEqual(refAt("  fo|o + 1"), expected);
  });

  it("resolves imported names, through their alias if any", () => {
    assert.deepStrictEqual(refAt("  |base_fee + 1"), {
      kind: "imported",
      module: "config/fees",
      name: "base_fee",
      localName: "base_fee",
    });
    assert.deepStrictEqual(refAt("  |flat_fee + 1"), {
      kind: "imported",
      module: "config/fees",
      name: "flat",
      localName: "flat_fee",
    });
  });

  it("resolves names qualified by a module alias", () => {
    assert.deepStrictEqual(refAt("  fees.|flat"), {
      kind: "qualified",
      module: "config/fees",
      name: "flat",
      qualifier: "fees",
    });
    assert.deepStrictEqual(refAt("  lim.|max"), {
      kind: "qualified",
      module: "config/limits",
      name: "max",
      qualifier: "lim",
    });
  });

  it("does not confuse division with a module path", () => {
    assert.deepStrictEqual(refAt("  total/|foo"), { kind: "local", name: "foo" });
    assert.deepStrictEqual(refAt("  |foo/2"), { kind: "local", name: "foo" });
  });

  it("reads a spread as a bare name", () => {
    assert.deepStrictEqual(refAt("  Foo { ..|foo }"), { kind: "local", name: "foo" });
  });

  it("rejects field accesses", () => {
    assert.strictEqual(refAt("  datum.|owner"), undefined);
    assert.strictEqual(refAt("  fees.a.|b"), undefined);
    assert.strictEqual(refAt("  foo().|b"), undefined);
    // The module itself is not a constant, but `fees` reads as a bare name.
    assert.deepStrictEqual(refAt("  |fees.flat"), { kind: "local", name: "fees" });
  });

  it("rejects labels and annotated parameters", () => {
    assert.strictEqual(refAt("  Foo { |bar: 1 }"), undefined);
    assert.strictEqual(refAt("fn f(|bar: Int) {"), undefined);
    assert.deepStrictEqual(refAt("  Foo { bar: |baz }"), { kind: "local", name: "baz" });
  });

  it("rejects strings and comments", () => {
    assert.strictEqual(refAt('  "some |foo"'), undefined);
    assert.strictEqual(refAt('  "esc\\" |foo"'), undefined);
    assert.strictEqual(refAt("  1 // |foo"), undefined);
    assert.deepStrictEqual(refAt('  "http://x" + |foo'), { kind: "local", name: "foo" });
  });

  it("rejects non-values", () => {
    assert.strictEqual(refAt("  |Foo"), undefined);
    assert.strictEqual(refAt("  |1_000"), undefined);
    assert.strictEqual(refAt("  1 |+ 1"), undefined);
    assert.strictEqual(refAt("use config/|fees"), undefined);
    assert.deepStrictEqual(refAt("use config/fees.{|base_fee}"), {
      kind: "imported",
      module: "config/fees",
      name: "base_fee",
      localName: "base_fee",
    });
  });
});

describe("isLocallyBound", () => {
  // Whether `fee` is bound on the last line of a function with this body.
  function bound(...body: string[]): boolean {
    const source = [
      "const other = 1",
      "",
      "pub fn caller(x: Int) {",
      ...body,
    ].join("\n");
    return isLocallyBound(source, 2 + body.length, "fee");
  }

  it("spots let and expect bindings", () => {
    assert.ok(bound("  let fee = 1", "  fee"));
    assert.ok(bound("  let fee: Int = 1", "  fee"));
    assert.ok(bound("  expect Some(fee) = x", "  fee"));
    assert.ok(bound("  let Foo { fee, .. } = x", "  fee"));
    assert.ok(bound("  let fee <- foo()", "  fee"));
    assert.ok(bound("  fee <- foo()", "  fee"));
  });

  it("spots branch patterns", () => {
    assert.ok(bound("  when x is {", "    Some(fee) -> fee"));
  });

  it("spots parameters, even multi-line ones", () => {
    assert.ok(isLocallyBound("fn f(fee: Int) {\n  fee\n}", 1, "fee"));
    assert.ok(isLocallyBound("fn f(\n  a: Int,\n  fee: (Int, Int),\n) {\n  fee\n}", 4, "fee"));
    assert.ok(bound("  list.map(x, fn(fee) { fee })"));
    assert.ok(isLocallyBound("validator v(fee: Int) {\n  spend(a) {\n    fee\n  }\n}", 2, "fee"));
    assert.ok(isLocallyBound("validator v {\n  spend(a, fee, c) {\n    fee\n  }\n}", 2, "fee"));
  });

  it("does not take uses for bindings", () => {
    assert.ok(!bound("  fee"));
    assert.ok(!bound("  let y = fee"));
    assert.ok(!bound("  expect fee == 1"));
    assert.ok(!bound("  expect fee >= 1"));
    assert.ok(!bound("  expect foo(fee) == 1"));
    assert.ok(!bound("  Some(x) -> fee"));
    assert.ok(!bound("  foo(fee)"));
    assert.ok(!bound("  x // let fee = 1"));
  });

  it("does not look past the enclosing declaration", () => {
    const source = ["fn f(fee: Int) {", "  let fee = 1", "}", "", "fn g() {", "  fee", "}"];
    assert.ok(!isLocallyBound(source.join("\n"), 5, "fee"));
  });

  it("does not look past the current line", () => {
    assert.ok(!isLocallyBound("fn f() {\n  fee\n  let fee = 1\n}", 1, "fee"));
  });
});
