// Devdy provider status line of the Translate tab (pure → unit-tested).

import type { DevdyStatusView } from '../shared/messages';

export interface DevdyStatusLine {
  text: string;
  tone: 'ok' | 'warn' | 'error';
  /** The fix is in the Devdy tab (token / app choice): highlight its link. */
  openDevdyTab: boolean;
}

export function devdyStatusLine(status: DevdyStatusView): DevdyStatusLine {
  const at = status.version ? `Devdy ${status.version}` : 'Devdy';
  switch (status.state) {
    case 'ready':
      return { text: `${at} found — translation ready.`, tone: 'ok', openDevdyTab: false };
    case 'not_running':
      return {
        text: 'Devdy is not running or its Inbox API is turned off.',
        tone: 'error',
        openDevdyTab: false,
      };
    case 'choose_instance':
      return { text: 'Several Devdy apps are running — pick one in the Devdy tab.', tone: 'warn', openDevdyTab: true };
    case 'unsupported':
      return {
        text: `${at} found, but it cannot translate. Update Devdy to a build with the translate feature.`,
        tone: 'error',
        openDevdyTab: false,
      };
    case 'no_token':
      return { text: `${at} found — set its token in the Devdy tab.`, tone: 'warn', openDevdyTab: true };
    case 'unauthorized':
      return { text: `${at} rejected the token — paste it again in the Devdy tab.`, tone: 'error', openDevdyTab: true };
  }
}
