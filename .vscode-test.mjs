import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'test/extension.test.js',
  // GitHub-hosted runners can take longer than test-electron's 15-second
  // default to resolve the latest VS Code release compatible with engines.vscode.
  download: { timeout: 60_000 },
});
