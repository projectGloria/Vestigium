import { mkdirSync, writeFileSync } from 'node:fs';
import { trayIconPng } from '../src/main/tray-icon.js';

// The application and installer icon: the tray mark at 256 px (electron-builder turns it into icon.ico).
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', trayIconPng(256));
console.log('build/icon.png written (256×256).');
