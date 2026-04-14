import ts from 'typescript';

export interface LanguageServiceBundle {
  host: ts.LanguageServiceHost;
  service: ts.LanguageService;
  program: ts.Program;
  typeChecker: ts.TypeChecker;
}

export function createLanguageService(): LanguageServiceBundle {
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => ({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      strict: true,
      skipLibCheck: true,
    }),
    getScriptFileNames: () =>
      ts.sys.readDirectory(process.cwd(), ['.ts', '.tsx', '.js', '.jsx']),
    getScriptVersion: () => '0',
    getScriptSnapshot: (fileName) => {
      const content = ts.sys.readFile(fileName);
      return content !== undefined
        ? ts.ScriptSnapshot.fromString(content)
        : undefined;
    },
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    readFile: (fileName) => ts.sys.readFile(fileName),
    fileExists: (fileName) => ts.sys.fileExists(fileName),
  };

  const service = ts.createLanguageService(host);
  const program = service.getProgram()!;
  const typeChecker = program.getTypeChecker();

  return { host, service, program, typeChecker };
}
