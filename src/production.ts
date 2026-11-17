// Muss vor React und Ink geladen werden (erster Import im Starter cli.ts): Ohne NODE_ENV=production
// laufen React und Ink in der langsamen Entwicklungsfassung und kosten im Leerlauf spürbar Rechenzeit.
process.env.NODE_ENV ??= 'production';
export {};
