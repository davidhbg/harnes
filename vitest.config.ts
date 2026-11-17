import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Nur unsere Tests – nicht, was KI-Sitzungen in Demo-Ordnern anlegen.
    include: ['test/**/*.test.ts'],
    // fester Name des Menschen in allen Tests (sonst käme er vom Systemkonto)
    env: { HARNES_BENUTZER: 'David' },
    // Die Oberflächen-Tests steuern echte Pseudo-Terminals; nacheinander laufen sie zuverlässig
    fileParallelism: false,
  },
});
