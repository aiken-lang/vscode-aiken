import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  extractModuleImports,
  extractTypeConstructors,
  extractTypeDeclarations,
  isBuiltin,
  moduleForUri,
  resolveTypeRef,
  tokenAtPosition,
} from "./typeDefinitions";

describe("extractTypeDeclarations", () => {
  it("finds data types, opaque types and aliases", () => {
    const source = [
      "pub type Foo {",
      "  x: Bar",
      "}",
      "",
      "opaque type Baz(x: Int)",
      "",
      "type Alias = Foo",
      "",
      "pub fn make() {",
      "  Foo { x: 1 }",
      "}",
    ].join("\n");

    const decls = extractTypeDeclarations(source);
    assert.deepStrictEqual(
      decls.map((d) => d.name),
      ["Foo", "Baz", "Alias"],
    );
    assert.strictEqual(decls[0].line, 0);
    assert.strictEqual(decls[1].line, 4);
    assert.strictEqual(decls[2].line, 6);
  });

  it("ignores comments and function declarations", () => {
    const source = [
      "// pub type Commented",
      "pub fn caller() {",
      "  pub type NotValid",
      "}",
    ].join("\n");
    assert.deepStrictEqual(extractTypeDeclarations(source), []);
  });
});

describe("extractModuleImports", () => {
  it("records module aliases from plain and `as` imports", () => {
    const imports = extractModuleImports(
      "use aiken/list\nuse aiken/collection/dict as dc\n",
    );
    assert.strictEqual(imports.moduleAliases.get("list"), "aiken/list");
    assert.strictEqual(
      imports.moduleAliases.get("dc"),
      "aiken/collection/dict",
    );
    assert.strictEqual(
      imports.moduleAliases.get("dict"),
      "aiken/collection/dict",
    );
  });

  it("records renamed and plain type imports", () => {
    const imports = extractModuleImports(
      "use aiken/collection/dict.{Dict, Pair as P}\n",
    );
    assert.deepStrictEqual(imports.importedNames.get("Dict"), {
      module: "aiken/collection/dict",
      name: "Dict",
    });
    assert.deepStrictEqual(imports.importedNames.get("P"), {
      module: "aiken/collection/dict",
      name: "Pair",
    });
  });

  it("ignores lowercase function imports", () => {
    const imports = extractModuleImports(
      "use aiken/list.{map, foldl as f}\n",
    );
    assert.strictEqual(imports.importedNames.size, 0);
  });
});

describe("resolveTypeRef", () => {
  const imports = extractModuleImports(
    "use aiken/list\nuse aiken/collection/dict.{Dict, Pair as P}\n",
  );

  it("resolves a bare imported name", () => {
    assert.deepStrictEqual(resolveTypeRef("Dict", imports), {
      kind: "imported",
      module: "aiken/collection/dict",
      name: "Dict",
    });
    assert.deepStrictEqual(resolveTypeRef("P", imports), {
      kind: "imported",
      module: "aiken/collection/dict",
      name: "Pair",
    });
  });

  it("resolves an alias-qualified type", () => {
    assert.deepStrictEqual(resolveTypeRef("list.Datum", imports), {
      kind: "alias",
      module: "aiken/list",
      name: "Datum",
    });
  });

  it("resolves a fully-qualified path", () => {
    assert.deepStrictEqual(resolveTypeRef("foo/bar/Baz", imports), {
      kind: "qualified",
      module: "foo/bar",
      name: "Baz",
    });
  });

  it("keeps unknown uppercase names as bare", () => {
    assert.deepStrictEqual(resolveTypeRef("Local", imports), {
      kind: "bare",
      name: "Local",
    });
  });

  it("returns undefined for prelude types", () => {
    assert.strictEqual(resolveTypeRef("Int", imports), undefined);
    assert.strictEqual(resolveTypeRef("list.Nil", imports), undefined);
  });

  it("returns undefined for lowercase references", () => {
    assert.strictEqual(resolveTypeRef("my_function", imports), undefined);
  });

  it("returns undefined for an unknown alias", () => {
    assert.strictEqual(resolveTypeRef("nope.Foo", imports), undefined);
  });
});

describe("isBuiltin", () => {
  it("recognises prelude types", () => {
    assert.strictEqual(isBuiltin("Int"), true);
    assert.strictEqual(isBuiltin("None"), true);
    assert.strictEqual(isBuiltin("Some"), true);
  });

  it("rejects user types", () => {
    assert.strictEqual(isBuiltin("MyType"), false);
  });
});

describe("extractTypeConstructors", () => {
  it("finds record-style constructors and picks the name column", () => {
    const source = [
      "pub type Thing {",
      "  Thing { x: Int, y: Int }",
      "  Widget { z: Int }",
      "}",
    ].join("\n");
    const ctors = extractTypeConstructors(source);
    assert.deepStrictEqual(
      ctors.map((c) => [c.name, c.line]),
      [
        ["Thing", 1],
        ["Widget", 2],
      ],
    );
    assert.strictEqual(ctors[0].column, source.split("\n")[1].indexOf("Thing"));
  });

  it("supports multi-constructor one-liners", () => {
    const source = "pub type Color { Red | Green | Blue }";
    assert.deepStrictEqual(
      extractTypeConstructors(source).map((c) => c.name),
      ["Red", "Green", "Blue"],
    );
  });

  it("supports parenthesized data constructors spanning lines", () => {
    const source = [
      "pub type Foo {",
      "  Bar {",
      "    a: Int,",
      "    b: Int,",
      "  }",
      "}",
    ].join("\n");
    assert.deepStrictEqual(
      extractTypeConstructors(source).map((c) => c.name),
      ["Bar"],
    );
  });

  it("skips type aliases", () => {
    const source = "pub type Alias = foo/bar/Baz";
    assert.deepStrictEqual(extractTypeConstructors(source), []);
  });

  it("ignores doc comments between constructors", () => {
    const source = [
      "pub type Foo {",
      "  /// docs about Bar",
      "  Bar",
      "  Baz",
      "}",
    ].join("\n");
    assert.deepStrictEqual(
      extractTypeConstructors(source).map((c) => c.name),
      ["Bar", "Baz"],
    );
  });

  it("handles opaque one-liners", () => {
    const source = "opaque type Wrapped { Wrapped(x: Int) }";
    assert.deepStrictEqual(
      extractTypeConstructors(source).map((c) => c.name),
      ["Wrapped"],
    );
  });

  it("does not pick up function names outside type blocks", () => {
    const source = [
      "pub fn do_thing() {",
      "  Foo { x: 1 }",
      "}",
    ].join("\n");
    assert.deepStrictEqual(extractTypeConstructors(source), []);
  });
});

describe("tokenAtPosition", () => {
  it("returns the whole identifier when the cursor is mid-token", () => {
    assert.strictEqual(tokenAtPosition("pub fn one() -> Local {", 16), "Local");
    assert.strictEqual(tokenAtPosition("pub fn one() -> Local {", 19), "Local");
  });

  it("returns undefined on whitespace", () => {
    assert.strictEqual(tokenAtPosition("x: Int", 2), undefined);
    assert.strictEqual(tokenAtPosition("pub fn", 3), undefined);
  });

  it("includes slashes and dots for qualified/alias refs", () => {
    assert.strictEqual(tokenAtPosition("let x: foo/bar/Baz", 11), "foo/bar/Baz");
    assert.strictEqual(tokenAtPosition("let y: list.Datum", 10), "list.Datum");
  });

  it("handles the very start and end of a line", () => {
    assert.strictEqual(tokenAtPosition("Local", 0), "Local");
    assert.strictEqual(tokenAtPosition("Local", 4), "Local");
  });
});

describe("moduleForUri", () => {
  it("computes the module name relative to the aiken.toml root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiken-test-"));
    try {
      fs.mkdirSync(path.join(root, "lib", "foo"), { recursive: true });
      fs.writeFileSync(path.join(root, "aiken.toml"), "");
      const a = path.join(root, "lib", "foo", "bar.ak");
      fs.writeFileSync(a, "");
      assert.strictEqual(moduleForUri(a, [root]), "foo/bar");

      const atRoot = path.join(root, "root_mod.ak");
      fs.writeFileSync(atRoot, "");
      assert.strictEqual(moduleForUri(atRoot, [root]), "root_mod");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the containing workspace root when there is no aiken.toml", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiken-test-"));
    try {
      fs.mkdirSync(path.join(root, "nested"), { recursive: true });
      const a = path.join(root, "nested", "m.ak");
      fs.writeFileSync(a, "");
      assert.strictEqual(moduleForUri(a, [root]), "nested/m");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined for non-aiken files", () => {
    assert.strictEqual(moduleForUri("/tmp/x/uplc.txt", []), undefined);
  });
});