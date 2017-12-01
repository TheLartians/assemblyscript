import { PATH_DELIMITER } from "./constants";
import { DiagnosticCode, DiagnosticMessage, DiagnosticEmitter } from "./diagnostics";
import { Module, MemorySegment, ExpressionRef, UnaryOp, BinaryOp, HostOp, NativeType, FunctionTypeRef } from "./module";
import { Program, ClassPrototype, Class, Element, ElementKind, Enum, FunctionPrototype, Function, Global, Local, Namespace, Parameter } from "./program";
import { CharCode, I64, U64, normalizePath, sb } from "./util";
import { Token, Range } from "./tokenizer";
import {

  Node,
  NodeKind,
  TypeNode,
  TypeParameter,
  Source,

  // statements
  BlockStatement,
  BreakStatement,
  ClassDeclaration,
  ContinueStatement,
  DeclarationStatement,
  DoStatement,
  EmptyStatement,
  EnumDeclaration,
  EnumValueDeclaration,
  ExportMember,
  ExportStatement,
  ExpressionStatement,
  FieldDeclaration,
  FunctionDeclaration,
  ForStatement,
  IfStatement,
  ImportStatement,
  MethodDeclaration,
  ModifierKind,
  NamespaceDeclaration,
  ReturnStatement,
  Statement,
  SwitchCase,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  VariableLikeDeclarationStatement,
  VariableDeclaration,
  VariableStatement,
  WhileStatement,

  // expressions
  ArrayLiteralExpression,
  AssertionExpression,
  BinaryExpression,
  CallExpression,
  ElementAccessExpression,
  Expression,
  FloatLiteralExpression,
  IdentifierExpression,
  IntegerLiteralExpression,
  LiteralExpression,
  LiteralKind,
  NewExpression,
  ParenthesizedExpression,
  PropertyAccessExpression,
  SelectExpression,
  StringLiteralExpression,
  UnaryPostfixExpression,
  UnaryPrefixExpression,

  hasModifier

} from "./ast";
import {

  Type,
  TypeKind,

} from "./types";

export enum Target {
  /** WebAssembly with 32-bit pointers. */
  WASM32,
  /** WebAssembly with 64-bit pointers. Experimental and not supported by any runtime yet. */
  WASM64
}

export class Options {
  /** WebAssembly target. Defaults to {@link Target.WASM32}. */
  target: Target = Target.WASM32;
  /** If true, performs compilation as usual but doesn't produce any output (all calls to module become nops). */
  noEmit: bool = false;
  /** If true, compiles everything instead of just reachable code. */
  noTreeShaking: bool = false;
}

export class Compiler extends DiagnosticEmitter {

  /** Program reference. */
  program: Program;
  /** Provided options. */
  options: Options;
  /** Module instance being compiled. */
  module: Module;

  /** Start function being compiled. */
  startFunction: Function;
  /** Start function expressions. */
  startFunctionBody: ExpressionRef[] = new Array();

  /** Current type in compilation. */
  currentType: Type = Type.void;
  /** Current function in compilation. */
  currentFunction: Function;
  /** Marker indicating whether continue statements are allowed in the current break context. */
  disallowContinue: bool = true;

  /** Counting memory offset. */
  memoryOffset: U64 = new U64(8, 0); // leave space for (any size of) NULL
  /** Memory segments being compiled. */
  memorySegments: MemorySegment[] = new Array();

  /** Already processed file names. */
  files: Set<string> = new Set();

  /** Compiles a {@link Program} to a {@link Module} using the specified options. */
  static compile(program: Program, options: Options | null = null): Module {
    const compiler: Compiler = new Compiler(program, options);
    return compiler.compile();
  }

  /** Constructs a new compiler for a {@link Program} using the specified options. */
  constructor(program: Program, options: Options | null = null) {
    super(program.diagnostics);
    this.program = program;
    this.options = options ? options : new Options();
    this.module = this.options.noEmit ? Module.createStub() : Module.create();
    const startFunctionTemplate: FunctionPrototype = new FunctionPrototype(program, "start", null);
    const startFunctionInstance: Function = new Function(startFunctionTemplate, startFunctionTemplate.internalName, [], [], Type.void, null);
    this.currentFunction = this.startFunction = startFunctionInstance;
    this.memoryOffset = new U64(2 * (this.options.target == Target.WASM64 ? 8 : 4), 0); // leave space for `null` and heapStart (both of usize type)
  }

  /** Performs compilation of the underlying {@link Program} to a {@link Module}. */
  compile(): Module {
    const program: Program = this.program;

    // initialize lookup maps
    program.initialize(this.options.target);

    // compile entry file (exactly one, usually)
    const sources: Source[] = program.sources;
    let i: i32, k: i32 = sources.length;
    for (i = 0; i < k; ++i) {
      const source: Source = sources[i];
      if (source.isEntry)
        this.compileSource(source);
    }

    // make start function if not empty
    if (this.startFunctionBody.length) {
      let typeRef: FunctionTypeRef = this.module.getFunctionTypeBySignature(NativeType.None, []);
      if (!typeRef)
        typeRef = this.module.addFunctionType("v", NativeType.None, []);
      this.module.setStart(
        this.module.addFunction(this.startFunction.template.internalName, typeRef, typesToNativeTypes(this.startFunction.additionalLocals), this.module.createBlock(null, this.startFunctionBody))
      );
    }

    // set up memory
    // store heapStart at `sizeof<usize>()` (that is right after `null`) as an usize
    const initial: U64 = this.memoryOffset.clone();
    let heapStartBuffer: Uint8Array;
    let heapStartOffset: i32;
    if (this.options.target == Target.WASM64) {
      heapStartBuffer = new Uint8Array(8);
      heapStartOffset = 8;
      heapStartBuffer[0] = (initial.lo       ) as u8;
      heapStartBuffer[1] = (initial.lo >>>  8) as u8;
      heapStartBuffer[2] = (initial.lo >>> 16) as u8;
      heapStartBuffer[3] = (initial.lo >>> 24) as u8;
      heapStartBuffer[4] = (initial.hi       ) as u8;
      heapStartBuffer[5] = (initial.hi >>>  8) as u8;
      heapStartBuffer[6] = (initial.hi >>> 16) as u8;
      heapStartBuffer[7] = (initial.hi >>> 24) as u8;
    } else {
      if (!initial.fitsInU32)
        throw new Error("memory size overflow");
      heapStartBuffer = new Uint8Array(4);
      heapStartOffset = 4;
      heapStartBuffer[0] = (initial.lo       ) as u8;
      heapStartBuffer[1] = (initial.lo >>>  8) as u8;
      heapStartBuffer[2] = (initial.lo >>> 16) as u8;
      heapStartBuffer[3] = (initial.lo >>> 24) as u8;
    }
    this.memorySegments.push(MemorySegment.create(heapStartBuffer, new U64(heapStartOffset, 0)));
    // determine initial page size
    const initialOverlaps: U64 = initial.clone();
    initialOverlaps.and32(0xffff);
    if (!initialOverlaps.isZero) {
      initial.or32(0xffff);
      initial.add32(1);
    }
    initial.shru32(16); // initial size in 64k pages
    this.module.setMemory(initial.toI32(), Module.MAX_MEMORY_WASM32 /* TODO: not WASM64 compatible yet */, this.memorySegments, this.options.target, "memory");

    return this.module;
  }

  // sources

  compileSourceByPath(normalizedPath: string, reportNode: Node): void {
    for (let i: i32 = 0, k: i32 = this.program.sources.length; i < k; ++i) {
      const importedSource: Source = this.program.sources[i];
      if (importedSource.normalizedPath == normalizedPath) {
        this.compileSource(importedSource);
        return;
      }
    }
    this.error(DiagnosticCode.File_0_not_found, reportNode.range, normalizedPath);
  }

  compileSource(source: Source): void {
    if (this.files.has(source.normalizedPath))
      return;
    this.files.add(source.normalizedPath);

    const isEntry: bool = source.isEntry;
    const noTreeShaking: bool = this.options.noTreeShaking;
    for (let i: i32 = 0, k: i32 = source.statements.length; i < k; ++i) {
      const statement: Statement = source.statements[i];
      switch (statement.kind) {

        case NodeKind.CLASS:
          if ((noTreeShaking || isEntry && hasModifier(ModifierKind.EXPORT, (<ClassDeclaration>statement).modifiers)) && !(<ClassDeclaration>statement).typeParameters.length)
            this.compileClassDeclaration(<ClassDeclaration>statement, []);
          break;

        case NodeKind.ENUM:
          if (noTreeShaking || isEntry && hasModifier(ModifierKind.EXPORT, (<EnumDeclaration>statement).modifiers))
            this.compileEnumDeclaration(<EnumDeclaration>statement);
          break;

        case NodeKind.FUNCTION:
          if ((noTreeShaking || isEntry && hasModifier(ModifierKind.EXPORT, (<FunctionDeclaration>statement).modifiers)) && !(<FunctionDeclaration>statement).typeParameters.length)
            this.compileFunctionDeclaration(<FunctionDeclaration>statement, []);
          break;

        case NodeKind.IMPORT:
          this.compileSourceByPath((<ImportStatement>statement).normalizedPath, (<ImportStatement>statement).path);
          break;

        case NodeKind.NAMESPACE:
          if (noTreeShaking || isEntry && hasModifier(ModifierKind.EXPORT, (<NamespaceDeclaration>statement).modifiers))
            this.compileNamespaceDeclaration(<NamespaceDeclaration>statement);
          break;

        case NodeKind.VARIABLE:
          if (noTreeShaking || isEntry && hasModifier(ModifierKind.EXPORT, (<VariableStatement>statement).modifiers))
            this.compileVariableStatement(<VariableStatement>statement);
          break;

        case NodeKind.EXPORT:
          if ((<ExportStatement>statement).path)
            this.compileSourceByPath((<StringLiteralExpression>(<ExportStatement>statement).path).value, <StringLiteralExpression>(<ExportStatement>statement).path);
          if (noTreeShaking || isEntry)
            this.compileExportStatement(<ExportStatement>statement);
          break;

        // otherwise a top-level statement that is part of the start function's body
        default: {
          const previousFunction: Function = this.currentFunction;
          this.currentFunction = this.startFunction;
          this.startFunctionBody.push(this.compileStatement(statement));
          this.currentFunction = previousFunction;
          break;
        }
      }
    }
  }

  // globals

  compileGlobalDeclaration(declaration: VariableDeclaration, isConst: bool): bool {
    const element: Element | null = <Element | null>this.program.elements.get(declaration.internalName);
    if (!element || element.kind != ElementKind.GLOBAL)
      throw new Error("unexpected missing global");
    return this.compileGlobal(<Global>element);
  }

  compileGlobal(element: Global): bool {
    if (element.isCompiled)
      return true;
    const declaration: VariableLikeDeclarationStatement | null = element.declaration;
    let type: Type | null = element.type;
    if (!type) {
      if (!declaration)
        throw new Error("unexpected missing declaration");
      if (!declaration.type)
        return false; // TODO: infer type? currently reported by parser
      type = this.program.resolveType(declaration.type); // reports
      if (!type)
        return false;
      element.type = type;
    }
    const nativeType: NativeType = typeToNativeType(<Type>type);
    let initializer: ExpressionRef;
    let initializeInStart: bool;
    if (element.hasConstantValue) {
      if (type.isLongInteger)
        initializer = element.constantIntegerValue ? this.module.createI64(element.constantIntegerValue.lo, element.constantIntegerValue.hi) : this.module.createI64(0, 0);
      else if (type.kind == TypeKind.F32)
        initializer = this.module.createF32(element.constantFloatValue);
      else if (type.kind == TypeKind.F64)
        initializer = this.module.createF64(element.constantFloatValue);
      else if (type.isSmallInteger) {
        if (type.isSignedInteger) {
          const shift: i32 = type.smallIntegerShift;
          initializer = this.module.createI32(element.constantIntegerValue ? element.constantIntegerValue.toI32() << shift >> shift : 0);
        } else
          initializer = this.module.createI32(element.constantIntegerValue ? element.constantIntegerValue.toI32() & type.smallIntegerMask: 0);
      } else
        initializer = this.module.createI32(element.constantIntegerValue ? element.constantIntegerValue.toI32() : 0);
      initializeInStart = false;
      this.module.addGlobal(element.internalName, nativeType, element.isMutable, initializer);
    } else if (declaration) {
      if (declaration.initializer) {
        initializer = this.compileExpression(declaration.initializer, type);
        initializeInStart = declaration.initializer.kind != NodeKind.LITERAL; // MVP doesn't support complex initializers
      } else {
        initializer = typeToNativeZero(this.module, type);
        initializeInStart = false;
      }
    } else
      throw new Error("unexpected missing declaration or constant value");
    const internalName: string = element.internalName;
    if (initializeInStart) {
      this.module.addGlobal(internalName, NativeType.I32, true, this.module.createI32(-1));
      this.startFunctionBody.push(this.module.createSetGlobal(internalName, initializer));
    } else
      this.module.addGlobal(internalName, NativeType.I32, element.isMutable, initializer);
    return element.isCompiled = true;
  }

  // enums

  compileEnumDeclaration(declaration: EnumDeclaration): void {
    const element: Element | null = <Element | null>this.program.elements.get(declaration.internalName);
    if (!element || element.kind != ElementKind.ENUM)
      throw new Error("unexpected missing enum");
    this.compileEnum(<Enum>element);
  }

  compileEnum(element: Enum): void {
    if (element.isCompiled)
      return;
    element.isCompiled = true;
    let previousInternalName: string | null = null;
    for (let [key, val] of element.members) {
      if (val.hasConstantValue) {
        this.module.addGlobal(val.internalName, NativeType.I32, false, this.module.createI32(val.constantValue));
      } else if (val.declaration) {
        const declaration: EnumValueDeclaration = val.declaration;
        let initializer: ExpressionRef;
        let initializeInStart: bool = false;
        if (declaration.value) {
          initializer = this.compileExpression(<Expression>declaration.value, Type.i32);
          initializeInStart = declaration.value.kind != NodeKind.LITERAL; // MVP doesn't support complex initializers
        } else if (previousInternalName == null) {
          initializer = this.module.createI32(0);
          initializeInStart = false;
        } else {
          initializer = this.module.createBinary(BinaryOp.AddI32,
            this.module.createGetGlobal(previousInternalName, NativeType.I32),
            this.module.createI32(1)
          );
          initializeInStart = true;
        }
        if (initializeInStart) {
          this.module.addGlobal(val.internalName, NativeType.I32, true, this.module.createI32(-1));
          this.startFunctionBody.push(this.module.createSetGlobal(val.internalName, initializer));
        } else
          this.module.addGlobal(val.internalName, NativeType.I32, false, initializer);
      } else
        throw new Error("unexpected missing declaration or constant value");
      previousInternalName = val.internalName;
    }
  }

  // functions

  compileFunctionDeclaration(declaration: FunctionDeclaration, typeArguments: TypeNode[], contextualTypeArguments: Map<string,Type> | null = null, alternativeReportNode: Node | null = null): void {
    const internalName: string = declaration.internalName;
    const element: Element | null = <Element | null>this.program.elements.get(internalName);
    if (!element || element.kind != ElementKind.FUNCTION_PROTOTYPE)
      throw new Error("unexpected missing function");
    this.compileFunctionUsingTypeArguments(<FunctionPrototype>element, typeArguments, contextualTypeArguments, alternativeReportNode);
  }

  compileFunctionUsingTypeArguments(prototype: FunctionPrototype, typeArguments: TypeNode[], contextualTypeArguments: Map<string,Type> | null = null, alternativeReportNode: Node | null = null) {
    const instance: Function | null = prototype.resolveInclTypeArguments(typeArguments, contextualTypeArguments, alternativeReportNode); // reports
    if (!instance)
      return;
    this.compileFunction(instance);
  }

  compileFunction(instance: Function): void {
    if (instance.isCompiled)
      return;

    const declaration: FunctionDeclaration | null = instance.template.declaration;
    if (!declaration) // TODO: compile builtins
      throw new Error("not implemented");

    if (!declaration.statements) {
      this.error(DiagnosticCode.Function_implementation_is_missing_or_not_immediately_following_the_declaration, declaration.identifier.range);
      return;
    }
    instance.isCompiled = true;

    // compile statements
    const previousFunction: Function = this.currentFunction;
    this.currentFunction = instance;
    const stmts: ExpressionRef[] = this.compileStatements(<Statement[]>declaration.statements);
    this.currentFunction = previousFunction;

    // create the function
    let k: i32 = instance.parameters.length;
    const binaryenResultType: NativeType = typeToNativeType(instance.returnType);
    const binaryenParamTypes: NativeType[] = new Array(k);
    const signatureNameParts: string[] = new Array(k + 1);
    for (let i: i32 = 0; i < k; ++i) {
      binaryenParamTypes[i] = typeToNativeType(instance.parameters[i].type);
      signatureNameParts[i] = typeToSignatureNamePart(instance.parameters[i].type);
    }
    signatureNameParts[k] = typeToSignatureNamePart(instance.returnType);
    let typeRef: FunctionTypeRef = this.module.getFunctionTypeBySignature(binaryenResultType, binaryenParamTypes);
    if (!typeRef)
      typeRef = this.module.addFunctionType(signatureNameParts.join(""), binaryenResultType, binaryenParamTypes);
    const internalName: string = instance.internalName;
    this.module.addFunction(internalName, typeRef, typesToNativeTypes(instance.additionalLocals), this.module.createBlock(null, stmts, NativeType.None));
    if (instance.globalExportName != null)
      this.module.addExport(internalName, <string>instance.globalExportName);
  }

  // namespaces

  compileNamespaceDeclaration(declaration: NamespaceDeclaration): void {
    const members: Statement[] = declaration.members;
    const noTreeShaking: bool = this.options.noTreeShaking;
    for (let i: i32 = 0, k: i32 = members.length; i < k; ++i) {
      const member: Statement = members[i];
      switch (member.kind) {

        case NodeKind.CLASS:
          if ((noTreeShaking || hasModifier(ModifierKind.EXPORT, (<ClassDeclaration>member).modifiers)) && !(<ClassDeclaration>member).typeParameters.length)
            this.compileClassDeclaration(<ClassDeclaration>member, []);
          break;

        case NodeKind.ENUM:
          if (noTreeShaking || hasModifier(ModifierKind.EXPORT, (<EnumDeclaration>member).modifiers))
            this.compileEnumDeclaration(<EnumDeclaration>member);
          break;

        case NodeKind.FUNCTION:
          if ((noTreeShaking || hasModifier(ModifierKind.EXPORT, (<FunctionDeclaration>member).modifiers)) && !(<FunctionDeclaration>member).typeParameters.length)
            this.compileFunctionDeclaration(<FunctionDeclaration>member, []);
          break;

        case NodeKind.NAMESPACE:
          if (noTreeShaking || hasModifier(ModifierKind.EXPORT, (<NamespaceDeclaration>member).modifiers))
            this.compileNamespaceDeclaration(<NamespaceDeclaration>member);
          break;

        case NodeKind.VARIABLE:
          if (noTreeShaking || hasModifier(ModifierKind.EXPORT, (<VariableStatement>member).modifiers))
            this.compileVariableStatement(<VariableStatement>member);
          break;

        default:
          throw new Error("unexpected namespace member");
      }
    }
    throw new Error("not implemented");
  }

  compileNamespace(ns: Namespace): void {
    const noTreeShaking: bool = this.options.noTreeShaking;
    for (let [name, element] of ns.members) {
      switch (element.kind) {

        case ElementKind.CLASS_PROTOTYPE:
          if ((noTreeShaking || (<ClassPrototype>element).isExport) && !(<ClassPrototype>element).isGeneric)
            this.compileClassUsingTypeArguments(<ClassPrototype>element, []);
          break;

        case ElementKind.ENUM:
          this.compileEnum(<Enum>element);
          break;

        case ElementKind.FUNCTION_PROTOTYPE:
          if ((noTreeShaking || (<FunctionPrototype>element).isExport) && !(<FunctionPrototype>element).isGeneric)
            this.compileFunctionUsingTypeArguments(<FunctionPrototype>element, []);
          break;

        case ElementKind.GLOBAL:
          this.compileGlobal(<Global>element);
          break;

        case ElementKind.NAMESPACE:
          this.compileNamespace(<Namespace>element);
          break;
      }
    }
  }

  // exports

  compileExportStatement(statement: ExportStatement): void {
    const members: ExportMember[] = statement.members;
    const internalPath: string | null = statement.path ? statement.internalPath : statement.range.source.internalPath;
    for (let i: i32 = 0, k: i32 = members.length; i < k; ++i) {
      const member: ExportMember = members[i];
      const internalExportName: string = internalPath + PATH_DELIMITER + member.identifier.name;
      const element: Element | null = <Element | null>this.program.exports.get(internalExportName);
      if (!element)
        throw new Error("unexpected missing element");
      switch (element.kind) {

        case ElementKind.CLASS_PROTOTYPE:
          if (!(<ClassPrototype>element).isGeneric)
            this.compileClassUsingTypeArguments(<ClassPrototype>element, []);
          break;

        case ElementKind.ENUM:
          this.compileEnum(<Enum>element);
          break;

        case ElementKind.FUNCTION_PROTOTYPE:
          if (!(<FunctionPrototype>element).isGeneric)
            this.compileFunctionUsingTypeArguments(<FunctionPrototype>element, []);
          break;

        case ElementKind.GLOBAL:
          this.compileGlobal(<Global>element);
          break;

        case ElementKind.NAMESPACE:
          this.compileNamespace(<Namespace>element);
          break;
      }
    }
  }

  // classes

  compileClassDeclaration(declaration: ClassDeclaration, typeArguments: TypeNode[], contextualTypeArguments: Map<string,Type> | null = null, alternativeReportNode: Node | null = null): void {
    const internalName: string = declaration.internalName;
    const element: Element | null = <Element | null>this.program.elements.get(internalName);
    if (!element || element.kind != ElementKind.CLASS_PROTOTYPE)
      throw new Error("unexpected missing class");
    this.compileClassUsingTypeArguments(<ClassPrototype>element, typeArguments, contextualTypeArguments, alternativeReportNode);
  }

  compileClassUsingTypeArguments(prototype: ClassPrototype, typeArguments: TypeNode[], contextualTypeArguments: Map<string,Type> | null = null, alternativeReportNode: Node | null = null): void {
    const instance: Class | null = prototype.resolveInclTypeArguments(typeArguments, contextualTypeArguments, alternativeReportNode);
    if (!instance)
      return;
    this.compileClass(instance);
  }

  compileClass(cls: Class) {
    throw new Error("not implemented");
  }

  // memory

  addMemorySegment(buffer: Uint8Array): MemorySegment {
    if (this.memoryOffset.lo & 7) { // align to 8 bytes so any possible data type is aligned here
      this.memoryOffset.or32(7);
      this.memoryOffset.add32(1);
    }
    const segment: MemorySegment = MemorySegment.create(buffer, this.memoryOffset.clone());
    this.memorySegments.push(segment);
    this.memoryOffset.add32(buffer.length);
    return segment;
  }

  // types

  determineExpressionType(expression: Expression, contextualType: Type): Type {
    const previousType: Type = this.currentType;
    const previousNoEmit: bool = this.module.noEmit;
    this.module.noEmit = true;
    this.compileExpression(expression, contextualType, false); // now performs a dry run
    const type: Type = this.currentType;
    this.currentType = previousType;
    this.module.noEmit = previousNoEmit;
    return type;
  }

  // statements

  compileStatement(statement: Statement): ExpressionRef {
    switch (statement.kind) {

      case NodeKind.BLOCK:
        return this.compileBlockStatement(<BlockStatement>statement);

      case NodeKind.BREAK:
        return this.compileBreakStatement(<BreakStatement>statement);

      case NodeKind.CONTINUE:
        return this.compileContinueStatement(<ContinueStatement>statement);

      case NodeKind.DO:
        return this.compileDoStatement(<DoStatement>statement);

      case NodeKind.EMPTY:
        return this.compileEmptyStatement(<EmptyStatement>statement);

      case NodeKind.EXPRESSION:
        return this.compileExpressionStatement(<ExpressionStatement>statement);

      case NodeKind.FOR:
        return this.compileForStatement(<ForStatement>statement);

      case NodeKind.IF:
        return this.compileIfStatement(<IfStatement>statement);

      case NodeKind.RETURN:
        return this.compileReturnStatement(<ReturnStatement>statement);

      case NodeKind.SWITCH:
        return this.compileSwitchStatement(<SwitchStatement>statement);

      case NodeKind.THROW:
        return this.compileThrowStatement(<ThrowStatement>statement);

      case NodeKind.TRY:
        return this.compileTryStatement(<TryStatement>statement);

      case NodeKind.VARIABLE:
        return this.compileVariableStatement(<VariableStatement>statement);

      case NodeKind.WHILE:
        return this.compileWhileStatement(<WhileStatement>statement);
    }
    throw new Error("unexpected statement kind");
  }

  compileStatements(statements: Statement[]): ExpressionRef[] {
    const k: i32 = statements.length;
    const stmts: ExpressionRef[] = new Array(k);
    for (let i: i32 = 0; i < k; ++i)
      stmts[i] = this.compileStatement(statements[i]);
    return stmts;
  }

  compileBlockStatement(statement: BlockStatement): ExpressionRef {
    return this.module.createBlock(null, this.compileStatements(statement.statements), NativeType.None);
  }

  compileBreakStatement(statement: BreakStatement): ExpressionRef {
    if (statement.label)
      throw new Error("not implemented");
    const context: string | null = this.currentFunction.breakContext;
    if (context != null)
      return this.module.createBreak("break$" + (<string>context));
    this.error(DiagnosticCode.A_break_statement_can_only_be_used_within_an_enclosing_iteration_or_switch_statement, statement.range);
    return this.module.createUnreachable();
  }

  compileContinueStatement(statement: ContinueStatement): ExpressionRef {
    if (statement.label)
      throw new Error("not implemented");
    const context: string | null = this.currentFunction.breakContext;
    if (context != null && !this.disallowContinue)
      return this.module.createBreak("continue$" + (<string>context));
    this.error(DiagnosticCode.A_continue_statement_can_only_be_used_within_an_enclosing_iteration_statement, statement.range);
    return this.module.createUnreachable();
  }

  compileDoStatement(statement: DoStatement): ExpressionRef {
    const label: string = this.currentFunction.enterBreakContext();
    const condition: ExpressionRef = this.compileExpression(statement.condition, Type.i32);
    const body: ExpressionRef = this.compileStatement(statement.statement);
    this.currentFunction.leaveBreakContext();
    const breakLabel: string = "break$" + label;
    const continueLabel: string = "continue$" + label;
    return this.module.createBlock(breakLabel, [
      this.module.createLoop(continueLabel,
        this.module.createBlock(null, [
          body,
          this.module.createBreak(continueLabel, condition)
        ], NativeType.None))
    ], NativeType.None);
  }

  compileEmptyStatement(statement: EmptyStatement): ExpressionRef {
    return this.module.createNop();
  }

  compileExpressionStatement(statement: ExpressionStatement): ExpressionRef {
    return this.compileExpression(statement.expression, Type.void);
  }

  compileForStatement(statement: ForStatement): ExpressionRef {
    const context: string = this.currentFunction.enterBreakContext();
    const initializer: ExpressionRef = statement.initializer ? this.compileStatement(<Statement>statement.initializer) : this.module.createNop();
    const condition: ExpressionRef = statement.condition ? this.compileExpression(<Expression>statement.condition, Type.i32) : this.module.createI32(1);
    const incrementor: ExpressionRef = statement.incrementor ? this.compileExpression(<Expression>statement.incrementor, Type.void) : this.module.createNop();
    const body: ExpressionRef = this.compileStatement(statement.statement);
    this.currentFunction.leaveBreakContext();
    const continueLabel: string = "continue$" + context;
    const breakLabel: string = "break$" + context;
    return this.module.createBlock(breakLabel, [
      initializer,
      this.module.createLoop(continueLabel, this.module.createBlock(null, [
        this.module.createIf(condition, this.module.createBlock(null, [
          body,
          incrementor,
          this.module.createBreak(continueLabel)
        ], NativeType.None))
      ], NativeType.None))
    ], NativeType.None);
  }

  compileIfStatement(statement: IfStatement): ExpressionRef {
    const condition: ExpressionRef = this.compileExpression(statement.condition, Type.i32);
    const ifTrue: ExpressionRef = this.compileStatement(statement.statement);
    const ifFalse: ExpressionRef = statement.elseStatement ? this.compileStatement(<Statement>statement.elseStatement) : 0;
    return this.module.createIf(condition, ifTrue, ifFalse);
  }

  compileReturnStatement(statement: ReturnStatement): ExpressionRef {
    if (this.currentFunction) {
      const expression: ExpressionRef = statement.expression ? this.compileExpression(<Expression>statement.expression, this.currentFunction.returnType) : 0;
      return this.module.createReturn(expression);
    }
    return this.module.createUnreachable();
  }

  compileSwitchStatement(statement: SwitchStatement): ExpressionRef {
    const context: string = this.currentFunction.enterBreakContext();
    const previousDisallowContinue: bool = this.disallowContinue;
    this.disallowContinue = true;

    // introduce a local for evaluating the condition (exactly once)
    const local: Local = this.currentFunction.addLocal(Type.i32);
    let i: i32, k: i32 = statement.cases.length;

    // prepend initializer to inner block
    const breaks: ExpressionRef[] = new Array(1 + k);
    breaks[0] = this.module.createSetLocal(local.index, this.compileExpression(statement.expression, Type.i32)); // initializer

    // make one br_if per (possibly dynamic) labeled case
    // TODO: take advantage of br_table where labels are known to be (sequential) constant (ideally the optimizer would)
    let breakIndex: i32 = 1;
    let defaultIndex: i32 = -1;
    for (i = 0; i < k; ++i) {
      const case_: SwitchCase = statement.cases[i];
      if (case_.label) {
        breaks[breakIndex++] = this.module.createBreak("case" + i.toString(10) + "$" + context, this.module.createBinary(BinaryOp.EqI32,
          this.module.createGetLocal(local.index, NativeType.I32),
          this.compileExpression(case_.label, Type.i32)
        ));
      } else
        defaultIndex = i;
    }

    // otherwise br to default respectively out of the switch if there is no default case
    breaks[breakIndex] = this.module.createBreak((defaultIndex >= 0
        ? "case" + defaultIndex.toString(10)
        : "break"
      ) + "$" + context);

    // nest blocks in order
    let currentBlock: ExpressionRef = this.module.createBlock("case0$" + context, breaks, NativeType.None);
    for (i = 0; i < k; ++i) {
      const case_: SwitchCase = statement.cases[i];
      const nextLabel: string = i == k - 1
        ? "break$" + context
        : "case" + (i + 1).toString(10) + "$" + context;
      const l: i32 = case_.statements.length;
      const body: ExpressionRef[] = new Array(1 + l);
      body[0] = currentBlock;
      for (let j: i32 = 0; j < l; ++j)
        body[j + 1] = this.compileStatement(case_.statements[j]);
      currentBlock = this.module.createBlock(nextLabel, body, NativeType.None);
    }
    this.currentFunction.leaveBreakContext();
    this.disallowContinue = previousDisallowContinue;

    return currentBlock;
  }

  compileThrowStatement(statement: ThrowStatement): ExpressionRef {
    return this.module.createUnreachable(); // TODO: waiting for exception-handling spec
  }

  compileTryStatement(statement: TryStatement): ExpressionRef {
    throw new Error("not implemented");
    // can't yet support something like: try { return ... } finally { ... }
    // worthwhile to investigate lowering returns to block results (here)?
  }

  compileVariableStatement(statement: VariableStatement): ExpressionRef {
    const declarations: VariableDeclaration[] = statement.declarations;

    // top-level variables become globals
    if (this.currentFunction == this.startFunction) {
      const isConst: bool = hasModifier(ModifierKind.CONST, statement.modifiers);
      for (let i: i32 = 0, k: i32 = declarations.length; i < k; ++i)
        this.compileGlobalDeclaration(declarations[i], isConst);
      return this.module.createNop();
    }
    // other variables become locals
    const initializers: ExpressionRef[] = new Array();
    for (let i: i32 = 0, k = declarations.length; i < k; ++i) {
      const declaration: VariableDeclaration = declarations[i];
      if (declaration.type) {
        const name: string = declaration.identifier.name;
        const type: Type | null = this.program.resolveType(<TypeNode>declaration.type, this.currentFunction.contextualTypeArguments, true); // reports
        if (type) {
          if (this.currentFunction.locals.has(name))
            this.error(DiagnosticCode.Duplicate_identifier_0, declaration.identifier.range, name); // recoverable
          else
            this.currentFunction.addLocal(<Type>type, name);
          if (declaration.initializer)
            initializers.push(this.compileAssignment(declaration.identifier, <Expression>declaration.initializer, Type.void));
        }
      }
    }
    return initializers.length ? this.module.createBlock(null, initializers, NativeType.None) : this.module.createNop();
  }

  compileWhileStatement(statement: WhileStatement): ExpressionRef {
    const label: string = this.currentFunction.enterBreakContext();
    const condition: ExpressionRef = this.compileExpression(statement.condition, Type.i32);
    const breakLabel: string = "break$" + label;
    const continueLabel: string = "continue$" + label;
    const body: ExpressionRef = this.compileStatement(statement.statement);
    this.currentFunction.leaveBreakContext();
    return this.module.createBlock(breakLabel, [
      this.module.createLoop(continueLabel,
        this.module.createIf(condition, this.module.createBlock(null, [
          body,
          this.module.createBreak(continueLabel)
        ], NativeType.None))
      )
    ], NativeType.None);
  }

  // expressions

  compileExpression(expression: Expression, contextualType: Type, convert: bool = true): ExpressionRef {
    this.currentType = contextualType;

    let expr: ExpressionRef;
    switch (expression.kind) {

      case NodeKind.ASSERTION:
        expr = this.compileAssertionExpression(<AssertionExpression>expression, contextualType);
        break;

      case NodeKind.BINARY:
        expr = this.compileBinaryExpression(<BinaryExpression>expression, contextualType);
        break;

      case NodeKind.CALL:
        expr = this.compileCallExpression(<CallExpression>expression, contextualType);
        break;

      case NodeKind.ELEMENTACCESS:
        expr = this.compileElementAccessExpression(<ElementAccessExpression>expression, contextualType);
        break;

      case NodeKind.IDENTIFIER:
      case NodeKind.FALSE:
      case NodeKind.NULL:
      case NodeKind.THIS:
      case NodeKind.TRUE:
        expr = this.compileIdentifierExpression(<IdentifierExpression>expression, contextualType);
        break;

      case NodeKind.LITERAL:
        expr = this.compileLiteralExpression(<LiteralExpression>expression, contextualType);
        break;

      case NodeKind.NEW:
        expr = this.compileNewExpression(<NewExpression>expression, contextualType);
        break;

      case NodeKind.PARENTHESIZED:
        expr = this.compileParenthesizedExpression(<ParenthesizedExpression>expression, contextualType);
        break;

      case NodeKind.PROPERTYACCESS:
        expr = this.compilePropertyAccessExpression(<PropertyAccessExpression>expression, contextualType);
        break;

      case NodeKind.SELECT:
        expr = this.compileSelectExpression(<SelectExpression>expression, contextualType);
        break;

      case NodeKind.UNARYPOSTFIX:
        expr = this.compileUnaryPostfixExpression(<UnaryPostfixExpression>expression, contextualType);
        break;

      case NodeKind.UNARYPREFIX:
        expr = this.compileUnaryPrefixExpression(<UnaryPrefixExpression>expression, contextualType);
        break;

      default:
        throw new Error("unexpected expression kind");
    }

    if (convert && this.currentType != contextualType) {
      expr = this.convertExpression(expr, this.currentType, contextualType);
      this.currentType = contextualType;
    }

    return expr;
  }

  convertExpression(expr: ExpressionRef, fromType: Type, toType: Type): ExpressionRef {

    // void to any
    if (fromType.kind == TypeKind.VOID)
      throw new Error("unexpected conversion from void");

    // any to void
    if (toType.kind == TypeKind.VOID)
      return this.module.createDrop(expr);

    const fromFloat: bool = fromType.isAnyFloat;
    const toFloat: bool = toType.isAnyFloat;

    const mod: Module = this.module;
    let losesInformation: bool = false;

    if (fromFloat) {

      // float to float
      if (toFloat) {
        if (fromType.kind == TypeKind.F32) {

          // f32 to f64
          if (toType.kind == TypeKind.F64)
            expr = mod.createUnary(UnaryOp.PromoteF32, expr);

        // f64 to f32
        } else if (toType.kind == TypeKind.F32) {
          losesInformation = true;
          expr = mod.createUnary(UnaryOp.DemoteF64, expr);
        }

      // float to int
      } else {
        losesInformation = true;

        // f32 to int
        if (fromType.kind == TypeKind.F32) {
          if (toType.isSignedInteger) {
            if (toType.isLongInteger)
              expr = mod.createUnary(UnaryOp.TruncF32_I64, expr);
            else {
              expr = mod.createUnary(UnaryOp.TruncF32_I32, expr);
              if (toType.isSmallInteger) {
                expr = mod.createBinary(BinaryOp.ShlI32, expr, mod.createI32(toType.smallIntegerShift));
                expr = mod.createBinary(BinaryOp.ShrI32, expr, mod.createI32(toType.smallIntegerShift));
              }
            }
          } else {
            if (toType.isLongInteger)
              expr = mod.createUnary(UnaryOp.TruncF32_U64, expr);
            else {
              expr = mod.createUnary(UnaryOp.TruncF32_U32, expr);
              if (toType.isSmallInteger)
                expr = mod.createBinary(BinaryOp.AndI32, expr, mod.createI32(toType.smallIntegerMask));
            }
          }

        // f64 to int
        } else {
          if (toType.isSignedInteger) {
            if (toType.isLongInteger)
              expr = mod.createUnary(UnaryOp.TruncF64_I64, expr);
            else {
              expr = mod.createUnary(UnaryOp.TruncF64_I32, expr);
              if (toType.isSmallInteger) {
                expr = mod.createBinary(BinaryOp.ShlI32, expr, mod.createI32(toType.smallIntegerShift));
                expr = mod.createBinary(BinaryOp.ShrI32, expr, mod.createI32(toType.smallIntegerShift));
              }
            }
          } else {
            if (toType.isLongInteger)
              expr = mod.createUnary(UnaryOp.TruncF64_U64, expr);
            else {
              expr = mod.createUnary(UnaryOp.TruncF64_U32, expr);
              if (toType.isSmallInteger)
                expr = mod.createBinary(BinaryOp.AndI32, expr, mod.createI32(toType.smallIntegerMask));
            }
          }
        }

      }

    // int to float
    } else if (toFloat) {

      // int to f32
      if (toType.kind == TypeKind.F32) {
        if (fromType.isLongInteger) {
          losesInformation = true;
          if (fromType.isSignedInteger)
            expr = mod.createUnary(UnaryOp.ConvertI64_F32, expr);
          else
            expr = mod.createUnary(UnaryOp.ConvertU64_F32, expr);
        } else
          if (fromType.isSignedInteger)
            expr = mod.createUnary(UnaryOp.ConvertI32_F32, expr);
          else
            expr = mod.createUnary(UnaryOp.ConvertU32_F32, expr);

      // int to f64
      } else {
        if (fromType.isLongInteger) {
          losesInformation = true;
          if (fromType.isSignedInteger)
            expr = mod.createUnary(UnaryOp.ConvertI64_F64, expr);
          else
            expr = mod.createUnary(UnaryOp.ConvertU64_F64, expr);
        } else
          if (fromType.isSignedInteger)
            expr = mod.createUnary(UnaryOp.ConvertI32_F64, expr);
          else
            expr = mod.createUnary(UnaryOp.ConvertU32_F64, expr);
      }

    // int to int
    } else {
      if (fromType.isLongInteger) {

        // i64 to i32
        if (!toType.isLongInteger) {
          losesInformation = true;
          expr = mod.createUnary(UnaryOp.WrapI64, expr);
          if (toType.isSmallInteger) {
            if (toType.isSignedInteger) {
              expr = mod.createBinary(BinaryOp.ShlI32, expr, mod.createI32(toType.smallIntegerShift));
              expr = mod.createBinary(BinaryOp.ShrI32, expr, mod.createI32(toType.smallIntegerShift));
            } else
              expr = mod.createBinary(BinaryOp.AndI32, expr, mod.createI32(toType.smallIntegerMask));
          }
        }

      // i32 to i64
      } else if (toType.isLongInteger) {
        if (toType.isSignedInteger)
          expr = mod.createUnary(UnaryOp.ExtendI32, expr);
        else
          expr = mod.createUnary(UnaryOp.ExtendU32, expr);

      // i32 to smaller/change of signage i32
      } else if (toType.isSmallInteger && (fromType.size > toType.size || (fromType.size == toType.size && fromType.kind != toType.kind))) {
        losesInformation = true;
        if (toType.isSignedInteger) {
          expr = mod.createBinary(BinaryOp.ShlI32, expr, mod.createI32(toType.smallIntegerShift));
          expr = mod.createBinary(BinaryOp.ShrI32, expr, mod.createI32(toType.smallIntegerShift));
        } else
          expr = mod.createBinary(BinaryOp.AndI32, expr, mod.createI32(toType.smallIntegerMask));
      }
    }

    return expr;
  }

  compileAssertionExpression(expression: AssertionExpression, contextualType: Type): ExpressionRef {
    const toType: Type | null = this.program.resolveType(expression.toType, this.currentFunction.contextualTypeArguments); // reports
    if (toType && toType != contextualType) {
      const expr: ExpressionRef = this.compileExpression(expression.expression, <Type>toType, false);
      return this.convertExpression(expr, this.currentType, <Type>toType);
    }
    return this.compileExpression(expression.expression, contextualType);
  }

  compileBinaryExpression(expression: BinaryExpression, contextualType: Type): ExpressionRef {
    let op: BinaryOp;
    let left: ExpressionRef;
    let right: ExpressionRef;
    let compound: Token = 0;

    switch (expression.operator) {

      case Token.LESSTHAN:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType == Type.f32
           ? BinaryOp.LtF32
           : this.currentType == Type.f64
           ? BinaryOp.LtF64
           : this.currentType.isLongInteger
           ? BinaryOp.LtI64
           : BinaryOp.LtI32;
        this.currentType = Type.bool;
        break;

      case Token.GREATERTHAN:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType == Type.f32
           ? BinaryOp.GtF32
           : this.currentType == Type.f64
           ? BinaryOp.GtF64
           : this.currentType.isLongInteger
           ? BinaryOp.GtI64
           : BinaryOp.GtI32;
        this.currentType = Type.bool;
        break;

      case Token.LESSTHAN_EQUALS:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType == Type.f32
           ? BinaryOp.LeF32
           : this.currentType == Type.f64
           ? BinaryOp.LeF64
           : this.currentType.isLongInteger
           ? BinaryOp.LeI64
           : BinaryOp.LeI32;
        this.currentType = Type.bool;
        break;

      case Token.GREATERTHAN_EQUALS:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType == Type.f32
           ? BinaryOp.GeF32
           : this.currentType == Type.f64
           ? BinaryOp.GeF64
           : this.currentType.isLongInteger
           ? BinaryOp.GeI64
           : BinaryOp.GeI32;
        this.currentType = Type.bool;
        break;

      case Token.EQUALS_EQUALS:
      case Token.EQUALS_EQUALS_EQUALS:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType == Type.f32
           ? BinaryOp.EqF32
           : this.currentType == Type.f64
           ? BinaryOp.EqF64
           : this.currentType.isLongInteger
           ? BinaryOp.EqI64
           : BinaryOp.EqI32;
        this.currentType = Type.bool;
        break;

      case Token.EQUALS:
        return this.compileAssignment(expression.left, expression.right, contextualType);

      case Token.PLUS_EQUALS:
        compound = Token.EQUALS;
      case Token.PLUS:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType == Type.f32
           ? BinaryOp.AddF32
           : this.currentType == Type.f64
           ? BinaryOp.AddF64
           : this.currentType.isLongInteger
           ? BinaryOp.AddI64
           : BinaryOp.AddI32;
        break;

      case Token.MINUS_EQUALS:
        compound = Token.EQUALS;
      case Token.MINUS:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType == Type.f32
           ? BinaryOp.SubF32
           : this.currentType == Type.f64
           ? BinaryOp.SubF64
           : this.currentType.isLongInteger
           ? BinaryOp.SubI64
           : BinaryOp.SubI32;
        break;

      case Token.ASTERISK_EQUALS:
        compound = Token.EQUALS;
      case Token.ASTERISK:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType == Type.f32
           ? BinaryOp.MulF32
           : this.currentType == Type.f64
           ? BinaryOp.MulF64
           : this.currentType.isLongInteger
           ? BinaryOp.MulI64
           : BinaryOp.MulI32;
        break;

      case Token.SLASH_EQUALS:
        compound = Token.EQUALS;
      case Token.SLASH:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType == Type.f32
           ? BinaryOp.DivF32
           : this.currentType == Type.f64
           ? BinaryOp.DivF64
           : this.currentType.isLongInteger
           ? BinaryOp.DivI64
           : BinaryOp.DivI32;
        break;

      case Token.PERCENT_EQUALS:
        compound = Token.EQUALS;
      case Token.PERCENT:
        left = this.compileExpression(expression.left, contextualType, false);
        right = this.compileExpression(expression.right, this.currentType);
        if (this.currentType.isAnyFloat)
          throw new Error("not implemented"); // TODO: internal fmod, possibly simply imported from JS
        op = this.currentType.isLongInteger
           ? BinaryOp.RemI64
           : BinaryOp.RemI32;
        break;

      case Token.LESSTHAN_LESSTHAN_EQUALS:
        compound = Token.EQUALS;
      case Token.LESSTHAN_LESSTHAN:
        left = this.compileExpression(expression.left, contextualType.isAnyFloat ? Type.i64 : contextualType);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType.isLongInteger
           ? BinaryOp.ShlI64
           : BinaryOp.ShlI32;
        break;

      case Token.GREATERTHAN_GREATERTHAN_EQUALS:
        compound = Token.EQUALS;
      case Token.GREATERTHAN_GREATERTHAN:
        left = this.compileExpression(expression.left, contextualType.isAnyFloat ? Type.i64 : contextualType);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType.isSignedInteger
           ? this.currentType.isLongInteger
             ? BinaryOp.ShrI64
             : BinaryOp.ShrI32
           : this.currentType.isLongInteger
             ? BinaryOp.ShrU64
             : BinaryOp.ShrU32;
        break;

      case Token.GREATERTHAN_GREATERTHAN_GREATERTHAN_EQUALS:
        compound = Token.EQUALS;
      case Token.GREATERTHAN_GREATERTHAN_GREATERTHAN:
        left = this.compileExpression(expression.left, contextualType.isAnyFloat ? Type.u64 : contextualType);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType.isLongInteger
           ? BinaryOp.ShrU64
           : BinaryOp.ShrU32;
        break;

      case Token.AMPERSAND_EQUALS:
        compound = Token.EQUALS;
      case Token.AMPERSAND:
        left = this.compileExpression(expression.left, contextualType.isAnyFloat ? Type.i64 : contextualType);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType.isLongInteger
           ? BinaryOp.AndI64
           : BinaryOp.AndI32;
        break;

      case Token.BAR_EQUALS:
        compound = Token.EQUALS;
      case Token.BAR:
        left = this.compileExpression(expression.left, contextualType.isAnyFloat ? Type.i64 : contextualType);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType.isLongInteger
           ? BinaryOp.OrI64
           : BinaryOp.OrI32;
        break;

      case Token.CARET_EQUALS:
        compound = Token.EQUALS;
      case Token.CARET:
        left = this.compileExpression(expression.left, contextualType.isAnyFloat ? Type.i64 : contextualType);
        right = this.compileExpression(expression.right, this.currentType);
        op = this.currentType.isLongInteger
           ? BinaryOp.XorI64
           : BinaryOp.XorI32;
        break;

      default:
        throw new Error("not implemented");
    }
    if (compound) {
      right = this.module.createBinary(op, left, right);
      return this.compileAssignmentWithValue(expression.left, right, contextualType != Type.void);
    }
    return this.module.createBinary(op, left, right);
  }

  compileAssignment(expression: Expression, valueExpression: Expression, contextualType: Type): ExpressionRef {
    this.currentType = this.determineExpressionType(expression, contextualType);
    return this.compileAssignmentWithValue(expression, this.compileExpression(valueExpression, this.currentType), contextualType != Type.void);
  }

  compileAssignmentWithValue(expression: Expression, valueWithCorrectType: ExpressionRef, tee: bool = false): ExpressionRef {
    const element: Element | null = this.program.resolveElement(expression, this.currentFunction);
    if (!element)
      return this.module.createUnreachable();

    if (element.kind == ElementKind.LOCAL) {
      if (tee) {
        this.currentType = (<Local>element).type;
        return this.module.createTeeLocal((<Local>element).index, valueWithCorrectType);
      }
      return this.module.createSetLocal((<Local>element).index, valueWithCorrectType);
    }

    if (element.kind == ElementKind.GLOBAL && (<Global>element).type) {
      if (tee) {
        const globalNativeType: NativeType = typeToNativeType(<Type>(<Global>element).type);
        this.currentType = <Type>(<Global>element).type;
        return this.module.createBlock(null, [ // teeGlobal
          this.module.createSetGlobal((<Global>element).internalName, valueWithCorrectType),
          this.module.createGetGlobal((<Global>element).internalName, globalNativeType)
        ], globalNativeType);
      }
      return this.module.createSetGlobal((<Global>element).internalName, valueWithCorrectType);
    }

    // TODO: fields, setters

    throw new Error("not implemented");
  }

  compileCallExpression(expression: CallExpression, contextualType: Type): ExpressionRef {
    const element: Element | null = this.program.resolveElement(expression.expression, this.currentFunction); // reports
    if (!element)
      return this.module.createUnreachable();
    if (element.kind == ElementKind.FUNCTION_PROTOTYPE) {
      const functionPrototype: FunctionPrototype = <FunctionPrototype>element;
      let functionInstance: Function | null = null;
      if (functionPrototype.isBuiltin) {
        sb.length = 0;
        for (let i: i32 = 0, k: i32 = expression.typeArguments.length; i < k; ++i) {
          let type: Type | null = this.program.resolveType(expression.typeArguments[i], this.currentFunction.contextualTypeArguments, true); // reports
          if (!type)
            return this.module.createUnreachable();
          sb.push(type.toString());
        }
        functionInstance = <Function | null>functionPrototype.instances.get(sb.join(","));
      } else {
        functionInstance = (<FunctionPrototype>element).resolveInclTypeArguments(expression.typeArguments, this.currentFunction.contextualTypeArguments, expression); // reports
      }
      if (!functionInstance)
        return this.module.createUnreachable();
      return this.compileCall(functionInstance, expression.arguments, expression);
    }
    this.error(DiagnosticCode.Cannot_invoke_an_expression_whose_type_lacks_a_call_signature_Type_0_has_no_compatible_call_signatures, expression.range, element.internalName);
    return this.module.createUnreachable();
  }

  /** Compiles a call to a function. If an instance method, `this` is the first element in `argumentExpressions`. */
  compileCall(functionInstance: Function, argumentExpressions: Expression[], reportNode: Node): ExpressionRef {

    // validate and compile arguments
    const parameters: Parameter[] = functionInstance.parameters;
    const parameterCount: i32 = parameters.length;
    const argumentCount: i32 = argumentExpressions.length;
    if (argumentExpressions.length > parameterCount) { // too many arguments
      this.error(DiagnosticCode.Expected_0_arguments_but_got_1, reportNode.range,
        (functionInstance.isInstance ? parameterCount - 1 : parameterCount).toString(10),
        (functionInstance.isInstance ? argumentCount - 1 : argumentCount).toString(10)
      );
      return this.module.createUnreachable();
    }
    const operands: ExpressionRef[] = new Array(parameterCount);
    for (let i: i32 = 0; i < parameterCount; ++i) {
      if (argumentExpressions.length > i) {
        operands[i] = this.compileExpression(argumentExpressions[i], parameters[i].type, true);
      } else {
        const initializer: Expression | null = parameters[i].initializer;
        if (initializer) { // omitted, uses initializer
          // FIXME: here, the initializer is compiled in the caller's scope.
          // a solution could be to use a stub for each possible overload, calling the
          // full function with optional arguments being part of the stub's body.
          operands[i] = this.compileExpression(initializer, parameters[i].type);
        } else { // too few arguments
          this.error(DiagnosticCode.Expected_at_least_0_arguments_but_got_1, reportNode.range,
            (functionInstance.isInstance ? i : i + 1).toString(10),
            (functionInstance.isInstance ? argumentCount - 1 : argumentCount).toString(10)
          );
          return this.module.createUnreachable();
        }
      }
    }

    this.currentType = functionInstance.returnType;

    let tempLocal: Local;
    if (functionInstance.isBuiltin) {
      switch (functionInstance.template.internalName) {

        case "clz": // i32/i64.clz
          if (this.currentType.isLongInteger)
            return this.module.createUnary(UnaryOp.ClzI64, operands[0]);
          else if (this.currentType.isAnyInteger)
            return this.module.createUnary(UnaryOp.ClzI32, operands[0]);
          break;

        case "ctz": // i32/i64.ctz
          if (this.currentType.isLongInteger)
            return this.module.createUnary(UnaryOp.CtzI64, operands[0]);
          else if (this.currentType.isAnyInteger)
            return this.module.createUnary(UnaryOp.CtzI32, operands[0]);
          break;

        case "popcnt": // i32/i64.popcnt
          if (this.currentType.isLongInteger)
            return this.module.createUnary(UnaryOp.PopcntI64, operands[0]);
          else if (this.currentType.isAnyInteger)
            return this.module.createUnary(UnaryOp.PopcntI32, operands[0]);
          break;

        case "rotl": // i32/i64.rotl
          if (this.currentType.isLongInteger)
            return this.module.createBinary(BinaryOp.RotlI64, operands[0], operands[1]);
          else if (this.currentType.isAnyInteger)
            return this.module.createBinary(BinaryOp.RotlI32, operands[0], operands[1]);
          break;

        case "rotr": // i32/i64.rotr
          if (this.currentType.isLongInteger)
            return this.module.createBinary(BinaryOp.RotrI64, operands[0], operands[1]);
          else if (this.currentType.isAnyInteger)
            return this.module.createBinary(BinaryOp.RotrI32, operands[0], operands[1]);
          break;

        case "abs": // f32/f64.abs
          if (this.currentType == Type.f64)
            return this.module.createUnary(UnaryOp.AbsF64, operands[0]);
          else if (this.currentType == Type.f32)
            return this.module.createUnary(UnaryOp.AbsF32, operands[0]);
          break;

        case "ceil": // f32/f64.ceil
          if (this.currentType == Type.f64)
            return this.module.createUnary(UnaryOp.CeilF64, operands[0]);
          else if (this.currentType == Type.f32)
            return this.module.createUnary(UnaryOp.CeilF32, operands[0]);
          break;

        case "copysign": // f32/f64.copysign
          if (this.currentType == Type.f64)
            return this.module.createBinary(BinaryOp.CopysignF64, operands[0], operands[1]);
          else if (this.currentType == Type.f32)
            return this.module.createBinary(BinaryOp.CopysignF32, operands[0], operands[1]);
          break;

        case "floor": // f32/f64.floor
          if (this.currentType == Type.f64)
            return this.module.createUnary(UnaryOp.FloorF64, operands[0]);
          else if (this.currentType == Type.f32)
            return this.module.createUnary(UnaryOp.FloorF32, operands[0]);
          break;

        case "max": // f32/f64.max
          if (this.currentType == Type.f64)
            return this.module.createBinary(BinaryOp.MaxF64, operands[0], operands[1]);
          else if (this.currentType == Type.f32)
            return this.module.createBinary(BinaryOp.MaxF32, operands[0], operands[1]);
          break;

        case "min": // f32/f64.min
          if (this.currentType == Type.f64)
            return this.module.createBinary(BinaryOp.MinF64, operands[0], operands[1]);
          else if (this.currentType == Type.f32)
            return this.module.createBinary(BinaryOp.MinF32, operands[0], operands[1]);
          break;

        case "nearest": // f32/f64.nearest
          if (this.currentType == Type.f64)
            return this.module.createUnary(UnaryOp.NearestF64, operands[0]);
          else if (this.currentType == Type.f32)
            return this.module.createUnary(UnaryOp.NearestF32, operands[0]);
          break;

        case "sqrt": // f32/f64.sqrt
          if (this.currentType == Type.f64)
            return this.module.createUnary(UnaryOp.SqrtF64, operands[0]);
          else if (this.currentType == Type.f32)
            return this.module.createUnary(UnaryOp.SqrtF32, operands[0]);
          break;

        case "trunc": // f32/f64.trunc
          if (this.currentType == Type.f64)
            return this.module.createUnary(UnaryOp.TruncF64, operands[0]);
          else if (this.currentType == Type.f32)
            return this.module.createUnary(UnaryOp.TruncF32, operands[0]);
          break;

        case "current_memory":
          return this.module.createHost(HostOp.CurrentMemory);

        case "grow_memory":
          this.warning(DiagnosticCode.Operation_is_unsafe, reportNode.range); // unsure
          return this.module.createHost(HostOp.GrowMemory, null, operands);

        case "unreachable":
          return this.module.createUnreachable();

        case "sizeof": // T.size
          if (this.options.target == Target.WASM64)
            return this.module.createI64(Math.ceil(functionInstance.typeArguments[0].size / 8), 0);
          return this.module.createI32(Math.ceil(functionInstance.typeArguments[0].size / 8));

        case "isNaN": // value != value
          if (functionInstance.typeArguments[0] == Type.f64) {
            tempLocal = this.currentFunction.addLocal(Type.f64);
            return this.module.createBinary(BinaryOp.NeF64,
              this.module.createTeeLocal(tempLocal.index, operands[0]),
              this.module.createGetLocal(tempLocal.index, NativeType.F64)
            );
          } else if (functionInstance.typeArguments[0] == Type.f32) {
            tempLocal = this.currentFunction.addLocal(Type.f32);
            return this.module.createBinary(BinaryOp.NeF32,
              this.module.createTeeLocal(tempLocal.index, operands[0]),
              this.module.createGetLocal(tempLocal.index, NativeType.F64)
            );
          }
          break;

        case "isFinite": // value != value ? false : abs(value) != Infinity
          if (functionInstance.typeArguments[0] == Type.f64) {
            tempLocal = this.currentFunction.addLocal(Type.f64);
            return this.module.createSelect(
              this.module.createBinary(BinaryOp.NeF64,
                this.module.createTeeLocal(tempLocal.index, operands[0]),
                this.module.createGetLocal(tempLocal.index, NativeType.F64)
              ),
              this.module.createI32(0),
              this.module.createBinary(BinaryOp.NeF64,
                this.module.createUnary(UnaryOp.AbsF64,
                  this.module.createGetLocal(tempLocal.index, NativeType.F64)
                ),
                this.module.createF64(Infinity)
              )
            );
          } else if (functionInstance.typeArguments[0] == Type.f32) {
            tempLocal = this.currentFunction.addLocal(Type.f32);
            return this.module.createSelect(
              this.module.createBinary(BinaryOp.NeF32,
                this.module.createTeeLocal(tempLocal.index, operands[0]),
                this.module.createGetLocal(tempLocal.index, NativeType.F32)
              ),
              this.module.createI32(0),
              this.module.createBinary(BinaryOp.NeF32,
                this.module.createUnary(UnaryOp.AbsF32,
                  this.module.createGetLocal(tempLocal.index, NativeType.F32)
                ),
                this.module.createF32(Infinity)
              )
            );
          }
          break;
      }
      this.error(DiagnosticCode.Operation_not_supported, reportNode.range);
      return this.module.createUnreachable();
    }

    if (!functionInstance.isCompiled)
      this.compileFunction(functionInstance);

    // imported function
    if (functionInstance.isImport)
      return this.module.createCallImport(functionInstance.internalName, operands, typeToNativeType(functionInstance.returnType));

    // internal function
    return this.module.createCall(functionInstance.internalName, operands, typeToNativeType(functionInstance.returnType));
  }

  compileElementAccessExpression(expression: ElementAccessExpression, contextualType: Type): ExpressionRef {
    const element: Element | null = this.program.resolveElement(expression.expression, this.currentFunction); // reports
    if (!element)
      return this.module.createUnreachable();
    throw new Error("not implemented");
  }

  compileIdentifierExpression(expression: IdentifierExpression, contextualType: Type): ExpressionRef {

    // null
    if (expression.kind == NodeKind.NULL) {
      if (contextualType.classType) // keep contextualType
        return this.options.target == Target.WASM64 ? this.module.createI64(0, 0) : this.module.createI32(0);
      if (this.options.target == Target.WASM64) {
        this.currentType = Type.u64;
        return this.module.createI64(0, 0);
      } else {
        this.currentType = Type.u32;
        return this.module.createI32(0);
      }

    // true
    } else if (expression.kind == NodeKind.TRUE) {
      this.currentType = Type.bool;
      return this.module.createI32(1);

    // false
    } else if (expression.kind == NodeKind.FALSE) {
      this.currentType = Type.bool;
      return this.module.createI32(0);

    // this
    } else if (expression.kind == NodeKind.THIS) {
      if (this.currentFunction.instanceMethodOf) {
        this.currentType = this.currentFunction.instanceMethodOf.type;
        return this.module.createGetLocal(0, typeToNativeType(this.currentType));
      }
      this.error(DiagnosticCode._this_cannot_be_referenced_in_current_location, expression.range);
      this.currentType = this.options.target == Target.WASM64 ? Type.u64 : Type.u32;
      return this.module.createUnreachable();
    }

    const element: Element | null = this.program.resolveElement(expression, this.currentFunction); // reports
    if (!element) {
      if (expression.kind == NodeKind.IDENTIFIER) {

        // NaN
        if ((<IdentifierExpression>expression).name == "NaN")
          if (this.currentType.kind == TypeKind.F32)
            return this.module.createF32(NaN);
          else {
            this.currentType = Type.f64;
            return this.module.createF64(NaN);
          }

        // Infinity
        if ((<IdentifierExpression>expression).name == "Infinity")
          if (this.currentType.kind == TypeKind.F32)
            return this.module.createF32(Infinity);
          else {
            this.currentType = Type.f64;
            return this.module.createF64(Infinity);
          }
      }
      return this.module.createUnreachable();
    }

    // local
    if (element.kind == ElementKind.LOCAL)
      return this.module.createGetLocal((<Local>element).index, typeToNativeType(this.currentType = (<Local>element).type));

    // global
    if (element.kind == ElementKind.GLOBAL)
      return this.compileGlobal(<Global>element) // reports
        ? this.module.createGetGlobal((<Global>element).internalName, typeToNativeType(this.currentType = <Type>(<Global>element).type))
        : this.module.createUnreachable();

    // field
    // if (element.kind == ElementKind.FIELD)
    //  throw new Error("not implemented");

    // getter
    if (element.kind == ElementKind.FUNCTION_PROTOTYPE && (<FunctionPrototype>element).isGetter)
      throw new Error("not implemented");

    this.error(DiagnosticCode.Operation_not_supported, expression.range);
    return this.module.createUnreachable();
  }

  compileLiteralExpression(expression: LiteralExpression, contextualType: Type): ExpressionRef {
    switch (expression.literalKind) {
      // case LiteralKind.ARRAY:

      case LiteralKind.FLOAT: {
        const floatValue: f64 = (<FloatLiteralExpression>expression).value;
        if (contextualType == Type.f32)
          return this.module.createF32(Math.fround(floatValue));
        this.currentType = Type.f64;
        return this.module.createF64(floatValue);
      }

      case LiteralKind.INTEGER: {
        const intValue: I64 = (<IntegerLiteralExpression>expression).value;
        if (contextualType == Type.bool && (intValue.isZero || intValue.isOne))
          return this.module.createI32(intValue.isZero ? 0 : 1);
        if (contextualType.isLongInteger)
          return this.module.createI64(intValue.lo, intValue.hi);
        if (!intValue.fitsInI32) {
          this.currentType = Type.i64;
          return this.module.createI64(intValue.lo, intValue.hi);
        }
        this.currentType = Type.i32;
        return this.module.createI32(intValue.toI32());
      }

      // case LiteralKind.OBJECT:
      // case LiteralKind.REGEXP:
      // case LiteralKind.STRING:
    }
    throw new Error("not implemented");
  }

  compileNewExpression(expression: NewExpression, contextualType: Type): ExpressionRef {
    throw new Error("not implemented");
  }

  compileParenthesizedExpression(expression: ParenthesizedExpression, contextualType: Type): ExpressionRef {
    return this.compileExpression(expression.expression, contextualType);
  }

  compilePropertyAccessExpression(expression: PropertyAccessExpression, contextualType: Type): ExpressionRef {
    throw new Error("not implemented");
  }

  compileSelectExpression(expression: SelectExpression, contextualType: Type): ExpressionRef {
    const condition: ExpressionRef = this.compileExpression(expression.condition, Type.i32);
    const ifThen: ExpressionRef = this.compileExpression(expression.ifThen, contextualType);
    const ifElse: ExpressionRef = this.compileExpression(expression.ifElse, contextualType);
    return this.module.createSelect(condition, ifThen, ifElse);
  }

  compileUnaryPostfixExpression(expression: UnaryPostfixExpression, contextualType: Type): ExpressionRef {
    const operator: Token = expression.operator;

    let op: BinaryOp;
    let nativeType: NativeType;
    let nativeOne: ExpressionRef;

    if (contextualType == Type.f32) {
      op = operator == Token.PLUS_PLUS ? BinaryOp.AddF32 : BinaryOp.SubF32;
      nativeType = NativeType.F32;
      nativeOne = this.module.createF32(1);
    } else if (contextualType == Type.f64) {
      op = operator == Token.PLUS_PLUS ? BinaryOp.AddF64 : BinaryOp.SubF64;
      nativeType = NativeType.F64;
      nativeOne = this.module.createF64(1);
    } else if (contextualType.isLongInteger) {
      op = operator == Token.PLUS_PLUS ? BinaryOp.AddI64 : BinaryOp.SubI64;
      nativeType = NativeType.I64;
      nativeOne = this.module.createI64(1, 0);
    } else {
      op = operator == Token.PLUS_PLUS ? BinaryOp.AddI32 : BinaryOp.SubI32;
      nativeType = NativeType.I32;
      nativeOne = this.module.createI32(1);
    }
    const getValue: ExpressionRef = this.compileExpression(expression.expression, contextualType);
    const setValue: ExpressionRef = this.compileAssignmentWithValue(expression.expression, this.module.createBinary(op, getValue, nativeOne), false); // reports

    return this.module.createBlock(null, [
      getValue,
      setValue
    ], nativeType);
  }

  compileUnaryPrefixExpression(expression: UnaryPrefixExpression, contextualType: Type): ExpressionRef {
    const operandExpression: Expression = expression.expression;

    let operand: ExpressionRef;
    let op: UnaryOp;

    switch (expression.operator) {

      case Token.PLUS:
        return this.compileExpression(operandExpression, contextualType);

      case Token.MINUS:
        operand = this.compileExpression(operandExpression, contextualType);
        if (this.currentType == Type.f32)
          op = UnaryOp.NegF32;
        else if (this.currentType == Type.f64)
          op = UnaryOp.NegF64;
        else
          return this.currentType.isLongInteger
               ? this.module.createBinary(BinaryOp.SubI64, this.module.createI64(0, 0), operand)
               : this.module.createBinary(BinaryOp.SubI32, this.module.createI32(0), operand);
        break;

      case Token.PLUS_PLUS:
        operand = this.compileExpression(operandExpression, contextualType);
        return this.currentType == Type.f32
             ? this.compileAssignmentWithValue(operandExpression, this.module.createBinary(BinaryOp.AddF32, operand, this.module.createF32(1)), contextualType != Type.void)
             : this.currentType == Type.f64
             ? this.compileAssignmentWithValue(operandExpression, this.module.createBinary(BinaryOp.AddF64, operand, this.module.createF64(1)), contextualType != Type.void)
             : this.currentType.isLongInteger
             ? this.compileAssignmentWithValue(operandExpression, this.module.createBinary(BinaryOp.AddI64, operand, this.module.createI64(1, 0)), contextualType != Type.void)
             : this.compileAssignmentWithValue(operandExpression, this.module.createBinary(BinaryOp.AddI32, operand, this.module.createI32(1)), contextualType != Type.void);

      case Token.MINUS_MINUS:
        operand = this.compileExpression(operandExpression, contextualType);
        return this.currentType == Type.f32
             ? this.compileAssignmentWithValue(operandExpression, this.module.createBinary(BinaryOp.SubF32, operand, this.module.createF32(1)), contextualType != Type.void)
             : this.currentType == Type.f64
             ? this.compileAssignmentWithValue(operandExpression, this.module.createBinary(BinaryOp.SubF64, operand, this.module.createF64(1)), contextualType != Type.void)
             : this.currentType.isLongInteger
             ? this.compileAssignmentWithValue(operandExpression, this.module.createBinary(BinaryOp.SubI64, operand, this.module.createI64(1, 0)), contextualType != Type.void)
             : this.compileAssignmentWithValue(operandExpression, this.module.createBinary(BinaryOp.SubI32, operand, this.module.createI32(1)), contextualType != Type.void);

      case Token.EXCLAMATION:
        operand = this.compileExpression(operandExpression, Type.bool, false);
        if (this.currentType == Type.f32) {
          this.currentType = Type.bool;
          return this.module.createBinary(BinaryOp.EqF32, operand, this.module.createF32(0));
        }
        if (this.currentType == Type.f64) {
          this.currentType = Type.bool;
          return this.module.createBinary(BinaryOp.EqF64, operand, this.module.createF64(0));
        }
        op = this.currentType.isLongInteger
           ? UnaryOp.EqzI64 // TODO: does this yield i64 0/1?
           : UnaryOp.EqzI32;
        this.currentType = Type.bool;
        break;

      case Token.TILDE:
        operand = this.compileExpression(operandExpression, contextualType.isAnyFloat ? Type.i64 : contextualType);
        return this.currentType.isLongInteger
             ? this.module.createBinary(BinaryOp.XorI64, operand, this.module.createI64(-1, -1))
             : this.module.createBinary(BinaryOp.XorI32, operand, this.module.createI32(-1));

      default:
        throw new Error("not implemented");
    }
    return this.module.createUnary(op, operand);
  }
}

// helpers

function typeToNativeType(type: Type): NativeType {
  return type.kind == TypeKind.F32
       ? NativeType.F32
       : type.kind == TypeKind.F64
       ? NativeType.F64
       : type.isLongInteger
       ? NativeType.I64
       : type.isAnyInteger || type.kind == TypeKind.BOOL
       ? NativeType.I32
       : NativeType.None;
}

function typesToNativeTypes(types: Type[]): NativeType[] {
  const k: i32 = types.length;
  const ret: NativeType[] = new Array(k);
  for (let i: i32 = 0; i < k; ++i)
    ret[i] = typeToNativeType(types[i]);
  return ret;
}

function typeToNativeZero(module: Module, type: Type): ExpressionRef {
  return type.kind == TypeKind.F32
       ? module.createF32(0)
       : type.kind == TypeKind.F64
       ? module.createF64(0)
       : type.isLongInteger
       ? module.createI64(0, 0)
       : module.createI32(0);
}

function typeToBinaryenOne(module: Module, type: Type): ExpressionRef {
  return type.kind == TypeKind.F32
       ? module.createF32(1)
       : type.kind == TypeKind.F64
       ? module.createF64(1)
       : type.isLongInteger
       ? module.createI64(1, 0)
       : module.createI32(1);
}

function typeToSignatureNamePart(type: Type): string {
  return type.kind == TypeKind.VOID
       ? "v"
       : type.kind == TypeKind.F32
       ? "f"
       : type.kind == TypeKind.F64
       ? "F"
       : type.isLongInteger
       ? "I"
       : "i";
}

function typesToSignatureName(paramTypes: Type[], returnType: Type): string {
  sb.length = 0;
  for (let i: i32 = 0, k: i32 = paramTypes.length; i < k; ++i)
    sb.push(typeToSignatureNamePart(paramTypes[i]));
  sb.push(typeToSignatureNamePart(returnType));
  return sb.join("");
}