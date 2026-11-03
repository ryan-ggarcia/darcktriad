import { defineConfig } from 'vitest/config';

// Os testes de tempo medem parede: arquivos em paralelo roubam CPU uns dos outros.
export default defineConfig({ test: { fileParallelism: false } });
