// The content script of every page and frame (`<all_urls>`, all_frames), built
// as ONE classic IIFE (dist/content.js, no global CSS):
// - Web → MD: "Send selection to Devdy" + its toasts
// - translator: selection toolbar/popup + full-page translation
// Both share the extension's isolated world in the page. Features don't import
// each other: this entry wires the translator's ➤ button to Web → MD.

import { setSelectionSender } from '../features/translator/content';
import { sendSelection } from '../features/web-to-md/content/send-selection';

setSelectionSender(sendSelection);
