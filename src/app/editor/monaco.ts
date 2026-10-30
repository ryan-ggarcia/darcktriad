import * as monaco from 'monaco-editor';

self.MonacoEnvironment = {
  // Só o worker base do editor: o realce de C, C++ e C# (Monarch) não usa worker próprio.
  getWorker: () => new Worker(new URL('./editor.worker', import.meta.url), { type: 'module' }),
};

export { monaco };
