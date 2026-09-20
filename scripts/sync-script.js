// Keeps public/x-nuke.js (what visitors download) identical to the canonical
// script/x-nuke.js, so there is only ever one copy to maintain.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public', { recursive: true });
copyFileSync('script/x-nuke.js', 'public/x-nuke.js');
console.log('synced script/x-nuke.js -> public/x-nuke.js');
