import { startApp } from './ui/app';
import './ui/styles.css';

function markIconsReady(): void {
  document.documentElement.classList.add('icons-ready');
}

if (document.fonts && 'ready' in document.fonts) {
  document.fonts.ready.then(markIconsReady).catch(markIconsReady);
} else {
  markIconsReady();
}
// Safety net: even if fonts.ready never resolves (some browsers, some edge
// cases), reveal the icons after a short delay so we never leave them
// permanently invisible.
setTimeout(markIconsReady, 1500);

startApp(document.getElementById('app')!);
