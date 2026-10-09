// Minimal shapes of the Slack Web API objects we consume.
// Everything is optional/loose on purpose: the internal web API can change
// and we must degrade gracefully instead of crashing.

export interface RichTextStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

export type RichTextInline =
  | { type: 'text'; text: string; style?: RichTextStyle }
  | { type: 'link'; url: string; text?: string; style?: RichTextStyle }
  | { type: 'user'; user_id: string; style?: RichTextStyle }
  | { type: 'channel'; channel_id: string; style?: RichTextStyle }
  | { type: 'usergroup'; usergroup_id: string; style?: RichTextStyle }
  | { type: 'emoji'; name: string; unicode?: string; skin_tone?: number; style?: RichTextStyle }
  | { type: 'broadcast'; range: string; style?: RichTextStyle }
  | { type: 'date'; timestamp: number; format?: string; fallback?: string; url?: string }
  | { type: 'color'; value: string }
  | { type: string; [key: string]: unknown };

export interface RichTextSection {
  type: 'rich_text_section';
  elements: RichTextInline[];
}

export interface RichTextList {
  type: 'rich_text_list';
  style: 'ordered' | 'bullet';
  indent?: number;
  offset?: number;
  border?: number;
  elements: RichTextSection[];
}

export interface RichTextPreformatted {
  type: 'rich_text_preformatted';
  elements: RichTextInline[];
  border?: number;
}

export interface RichTextQuote {
  type: 'rich_text_quote';
  elements: RichTextInline[];
  border?: number;
}

export type RichTextElement =
  | RichTextSection
  | RichTextList
  | RichTextPreformatted
  | RichTextQuote
  | { type: string; elements?: unknown[] };

export interface SlackTextObject {
  type: 'mrkdwn' | 'plain_text' | string;
  text: string;
}

export interface SlackBlock {
  type: string;
  block_id?: string;
  elements?: unknown[];
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  [key: string]: unknown;
}

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  permalink?: string;
  url_private?: string;
  /** Same as url_private but forces Content-Disposition: attachment. */
  url_private_download?: string;
  /** "hosted" | "snippet" | "post" | "external" | "tombstone" | "hidden_by_limit" … */
  mode?: string;
  mimetype?: string;
  filetype?: string;
  /** Bytes. */
  size?: number;
  /** Google Drive / Dropbox etc. — content is not hosted by Slack. */
  is_external?: boolean;
}

export interface SlackReaction {
  name: string;
  count?: number;
  users?: string[];
}

export interface SlackAttachment {
  fallback?: string;
  pretext?: string;
  title?: string;
  title_link?: string;
  text?: string;
  from_url?: string;
  author_name?: string;
}

export interface SlackUserProfileLite {
  display_name?: string;
  real_name?: string;
  name?: string;
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { id?: string; name?: string };
  user_profile?: SlackUserProfileLite;
  text?: string;
  blocks?: SlackBlock[];
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  reactions?: SlackReaction[];
  edited?: { user?: string; ts?: string };
  reply_count?: number;
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: SlackUserProfileLite & { real_name_normalized?: string; display_name_normalized?: string };
}

export interface SlackConversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  user?: string;
}

export interface SlackRepliesResponse {
  ok: boolean;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
  error?: string;
}
