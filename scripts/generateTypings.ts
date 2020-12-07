import { createPrinter, factory, SyntaxKind, TypeNode, NodeFlags, NewLineKind, PropertyDeclaration } from "typescript";
import yargs from "yargs/yargs";
import { promises as fs } from "fs";
import { parse, HTMLElement } from "node-html-parser";
import TurndownService from "turndown";
import { camelCase } from "change-case";

import typeOverrides from "./typeOverrides.json"; 

const zip = <T>(rows: T[][]) => rows[0].map((_, c) => rows.map(row => row[c]));

const TYPE_MAP = {
  "java.lang.String": "string",
  "int": "number",
  "long": "number",
  "double": "number",
  "java.lang.Integer": "number",
  "boolean": "boolean",
};

const REF_PATTERN =  /(?<type>.*?) <a.*?>(?<name>.*?)<\/a>\((?<paramTypes>.*)\)/;
const MAP_KEY_PATTERN = /\[([^:]+?)\]/g;

const MODIFIERS = {
  Abstract: factory.createModifier(SyntaxKind.AbstractKeyword),
  Declare: factory.createModifier(SyntaxKind.DeclareKeyword),
  Export: factory.createModifier(SyntaxKind.ExportKeyword),
  Readonly: factory.createModifier(SyntaxKind.ReadonlyKeyword),
  Static: factory.createModifier(SyntaxKind.StaticKeyword),
};

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

type JavaType = keyof typeof TYPE_MAP;

type Await<T> = T extends { then(onfulfilled?: (value: infer U) => unknown): unknown; } ? U : T;

class GenerateTypings {
  static MafiaClass = factory.createIdentifier("MafiaClass");

  static massageRefType(type: string) {
    if (type === "aggregate") return "any";
    return type.replace(MAP_KEY_PATTERN, (m, key) => `[key: ${key}]`);
  }

  static parseDataList(root: HTMLElement) {
    const dl = root.querySelector("dl");
    if (!dl) return [];
    return [...dl.childNodes]
      .filter(n => n.nodeType === 1)
      .reduce((acc, v, i, arr) => (i % 2 === 0) ? { ...acc, [v.innerText]: arr[i + 1] as HTMLElement } : acc, {} as { [label: string]: HTMLElement });
  }

  static resolveType(method: HTMLElement, dl: ReturnType<typeof GenerateTypings.parseDataList>) {
    const javaType = method.querySelector("span.returnType").innerText as JavaType;

    if (TYPE_MAP[javaType]) {
      return TYPE_MAP[javaType];
    }

    if ("Return Type:" in dl) {
      return dl["Return Type:"].innerText.replace(/Proxy$/, "");
    }

    return "any";
  }

  static aggregateTypeToTypeScript(proxyRecord: Await<ReturnType<GenerateTypings["parseProxyRecord"]>>) {
    const MafiaClassExpression = factory.createExpressionWithTypeArguments(GenerateTypings.MafiaClass, undefined);
    const MafiaClassHeritage = factory.createHeritageClause(SyntaxKind.ExtendsKeyword, [MafiaClassExpression]);

    const className = factory.createIdentifier(proxyRecord.className);
    const classNameType = factory.createTypeReferenceNode(className);
    const narrowedStatics = GenerateTypings.createMafiaClassProps(classNameType);

    const props = proxyRecord.fields.flatMap(f => {
      const type = factory.createTypeReferenceNode(f.type, undefined);
      // @ts-ignore
      const doc = factory.createJSDocComment(f.description, undefined) as PropertyDeclaration;
      return [doc, factory.createPropertyDeclaration(undefined, [MODIFIERS.Readonly], f.name, undefined, type, undefined)];
    });
    return factory.createClassDeclaration(undefined, undefined, className, undefined, [MafiaClassHeritage], [...narrowedStatics, ...props]);
  }

  static createMafiaClassProps(typeDefault?: TypeNode) {
    const t = factory.createIdentifier("T");
    const typeT = factory.createTypeReferenceNode(t);
    const typeArrayOfT = factory.createArrayTypeNode(typeT);
    const tParam = factory.createTypeParameterDeclaration(t, undefined, typeDefault);

    const typeNumber = factory.createTypeReferenceNode("number", undefined);
    const typeString = factory.createTypeReferenceNode("string", undefined);
    const typeNumberOrString = factory.createUnionTypeNode([typeNumber, typeString]);
    const typeArrayOfNumberOrString = factory.createArrayTypeNode(typeNumberOrString);

    const name = factory.createParameterDeclaration(undefined, undefined, undefined, "idOrName", undefined, typeNumberOrString, undefined);
    const names = factory.createParameterDeclaration(undefined, undefined, undefined, "idsOrNames", undefined, typeArrayOfNumberOrString, undefined);

    return [
      factory.createMethodDeclaration(undefined, [MODIFIERS.Static], undefined, "get", undefined, [tParam], [name], typeT, undefined),
      factory.createMethodDeclaration(undefined, [MODIFIERS.Static], undefined, "get", undefined, [tParam], [names], typeArrayOfT, undefined),
      factory.createMethodDeclaration(undefined, [MODIFIERS.Static], undefined, "all", undefined, [tParam], [], typeArrayOfT, undefined),
    ]
  }

  static createMafiaClass() {
    const props = GenerateTypings.createMafiaClassProps();
    return factory.createClassDeclaration(undefined, [MODIFIERS.Declare, MODIFIERS.Abstract], GenerateTypings.MafiaClass, undefined, undefined, props);
  }

  static runtimeMethodToTypeScript(method: Await<ReturnType<GenerateTypings["getListOfRuntimeMethods"]>>[0]) {
    const type = factory.createTypeReferenceNode(method.type, undefined);
    const paramToType = zip([method.params, method.paramTypes]);
    const params = paramToType.map(([p, pt]) => factory.createParameterDeclaration(undefined, undefined, undefined, p, undefined, factory.createTypeReferenceNode(pt, undefined), undefined));
    return factory.createFunctionDeclaration(undefined, [MODIFIERS.Export], undefined, method.name, undefined, params, type, undefined);
  }

  static parseArgs(args: string) {
    return args.substring(8, args.length - 1).split(",").map(a => a.split("&nbsp;")[1]).slice(1);
  }

  javadocsPath: string;
  refPath: string;
  turndown = new TurndownService();

  constructor(javadocsPath: string, refPath: string) {
    this.javadocsPath = javadocsPath;
    this.refPath = refPath;
  }

  async parseJavadoc(fileName: string) {
    return parse(await fs.readFile(`${this.javadocsPath}/net/sourceforge/kolmafia/textui/${fileName}.html`, "utf8"));
  }

  async parseRef() {
    return (await fs.readFile(this.refPath, "utf8")).split("\n").map(l => {
      const match = l.match(REF_PATTERN);
      if (!match || !match.groups) return null;
      const { name, type, paramTypes } = match.groups;
      return {
        name,
        type: GenerateTypings.massageRefType(type),
        paramTypes: paramTypes ? paramTypes.split(", ").map(t => GenerateTypings.massageRefType(t)) : [],
      };
    }).filter(notNull);
  }

  async getListOfRuntimeMethods() {
    const refs = await this.parseRef();
    const root = await this.parseJavadoc("RuntimeLibrary");
    const methods = root.querySelectorAll(".memberSummary tbody .colSecond code").map(m => {
      const name = camelCase(m.querySelector(".memberNameLink").innerText);
      const signature = m.childNodes[1];
      const params = signature ? GenerateTypings.parseArgs(signature.innerText) : [];

      return { name, params };
    });

    const res = refs.flatMap(r => methods.filter(m => m.name === r.name && m.params.length == r.paramTypes.length).map(m => ({ ...r, params: m.params }))).filter(r => r.name !== "delete");
    return res;
  }

  async getRuntimeLibrary() {
    return (await this.getListOfRuntimeMethods()).map(m => GenerateTypings.runtimeMethodToTypeScript(m));
  }

  async getListOfProxyRecords() {
    const root = await this.parseJavadoc("parsetree/ProxyRecordValue");
    const nodes = root.querySelectorAll("section.nestedClassSummary div.memberSummary tbody th.colSecond code span a");
    return [...nodes].map(a => (a.getAttribute("href") || "").replace(/\.html$/, ""));
  }

  async parseProxyRecord(proxyRecordFile: string) {
    const root = await this.parseJavadoc(`parsetree/${proxyRecordFile}`);

    const className = root.querySelector("h1.title").innerText.replace(/^Class ProxyRecordValue.(\w+)Proxy$/, "$1");

    const methodList = root.querySelectorAll("section.methodDetails section.detail");

    const fields = [...methodList].map(method => {
      const dataList = GenerateTypings.parseDataList(method);
      const name = method.querySelector("span.memberName").innerText.replace(/^get_/, "");

      const fieldPath = `${className}.${name}` as keyof typeof typeOverrides.proxyRecords;
      const type = typeOverrides.proxyRecords[fieldPath] || GenerateTypings.resolveType(method, dataList);

      const prettyName = name.charAt(0).toUpperCase() + name.substr(1).replace(/_/g, " ");
      const description = "Returns:" in dataList ? this.turndown.turndown(dataList["Returns:"].innerHTML) : prettyName;

      return { type, name: camelCase(name), description };
    });

    return {
      className,
      fields,
    };
  }

  async run() {
    const proxyRecordList = await this.getListOfProxyRecords();
    const runtimeLibrary = await this.getRuntimeLibrary();

    const printer = createPrinter({ newLine: NewLineKind.LineFeed });

    const aggregateTypes = [
      ...await Promise.all(proxyRecordList.map(a => this.parseProxyRecord(a))),
      ...typeOverrides.nonProxyAggregateTypes.map(className => ({ className, fields: [] })),
    ];
    const aggregateTypeNodes = aggregateTypes.map(p => GenerateTypings.aggregateTypeToTypeScript(p));

    const global = factory.createModuleDeclaration(
      undefined, [MODIFIERS.Declare], factory.createIdentifier("global"), factory.createModuleBlock(aggregateTypeNodes),
      NodeFlags.ExportContext | NodeFlags.GlobalAugmentation | NodeFlags.ContextFlags
    );

    const nodeArray = factory.createNodeArray([
      ...runtimeLibrary,
      GenerateTypings.createMafiaClass(),
      global,
    ]);

    const dts = factory.createSourceFile(nodeArray, factory.createToken(SyntaxKind.EndOfFileToken), NodeFlags.None);

    return printer.printFile(dts);
  }
}

async function main() {
  const argv = yargs(process.argv)
    .options({
      javadocPath: { type: "string", demandOption: true, alias: "jd" },
      // ash buffer o; o.append(cli_execute_output("jsref")); buffer_to_file(o, "jsref.txt");
      refPath: { type: "string", demandOption: true, alias: "ref", help: "Save the output of `jsref` in the Mafia cli to a text file and specify it here" },
      outputPath: { type: "string", default: "index.d.ts" },
    })
    .help()
    .argv;

  const generateTypings = new GenerateTypings(argv.javadocPath, argv.refPath);

  const result = await generateTypings.run();

  await fs.writeFile(argv.outputPath, result);

  console.log(`Successfully output ${result.length} char(s) to ${argv.outputPath}`)
}

main();


