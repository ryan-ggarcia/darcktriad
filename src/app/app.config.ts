import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { MonacoBuffers } from './editor/monaco-buffers';
import { TextBuffers } from './editor/text-buffer';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: TextBuffers, useClass: MonacoBuffers },
  ],
};
