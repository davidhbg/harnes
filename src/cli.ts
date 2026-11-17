#!/usr/bin/env node
// Starter: zuerst den Produktionsmodus setzen, erst danach React und Ink laden (sonst laufen sie in der
// langsamen Entwicklungsfassung). Das eigentliche Programm steht in harnes.tsx.
import './production.js';

void import('./harnes.js');
